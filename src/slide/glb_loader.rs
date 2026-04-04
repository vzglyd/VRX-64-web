//! GLB scene loading and compilation for web host.
//!
//! This module provides functionality to load GLB files and compile them
//! into slide specs that can be rendered by the web host.

use glam::{Mat3, Mat4, Vec3};
use serde::{Deserialize, Serialize};
use vzglyd_kernel::{ImportedCameraProjection, ImportedSceneCamera};
use vzglyd_kernel::{
    ImportedScene, ImportedSceneMeshNode,
    glb::{ImportedSceneMaterial, SceneAssetRef},
};
use vzglyd_slide::{
    CameraKeyframe, MeshAsset, MeshAssetVertex, PipelineKind, SceneAnchor, SceneAnchorSet,
};
use wasm_bindgen::prelude::*;

/// Result type for GLB loading operations.
pub type GlbResult<T> = Result<T, JsValue>;

/// A compiled scene mesh ready for rendering.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompiledSceneMesh {
    /// Unique ID for the mesh.
    pub id: String,
    /// Human-readable label.
    pub label: String,
    /// Vertex data.
    pub vertices: Vec<CompiledVertex>,
    /// Index data.
    pub indices: Vec<u16>,
    /// Pipeline kind (opaque/transparent).
    pub pipeline: String, // "opaque" or "transparent"
}

/// A vertex in a compiled scene mesh.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct CompiledVertex {
    /// Position in 3D space.
    pub position: [f32; 3],
    /// Normal vector.
    pub normal: [f32; 3],
    /// Vertex color (RGBA).
    pub color: [f32; 4],
    /// Material mode (0=opaque, 1=alpha_test, 2=transparent, 3=emissive, 5=water).
    pub mode: f32,
}

/// A compiled scene ready for rendering.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompiledScene {
    /// Scene ID.
    pub id: String,
    /// Scene label.
    pub label: Option<String>,
    /// Meshes in the scene.
    pub meshes: Vec<CompiledSceneMesh>,
    /// Anchors in the scene.
    pub anchors: Vec<CompiledSceneAnchor>,
    /// Camera path for the scene.
    pub camera_path: Option<CompiledCameraPath>,
    /// Lighting configuration.
    pub lighting: Option<CompiledWorldLighting>,
}

/// An anchor point in a compiled scene.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompiledSceneAnchor {
    /// Unique ID for the anchor.
    pub id: String,
    /// Human-readable label.
    pub label: String,
    /// World transform matrix (4x4).
    pub world_transform: [[f32; 4]; 4],
    /// Optional tag for the anchor.
    pub tag: Option<String>,
}

/// A camera path for a compiled scene.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompiledCameraPath {
    /// Whether the path loops.
    pub looped: bool,
    /// Keyframes in the path.
    pub keyframes: Vec<CompiledCameraKeyframe>,
}

/// A camera keyframe.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompiledCameraKeyframe {
    /// Time in seconds.
    pub time: f32,
    /// Camera position.
    pub position: [f32; 3],
    /// Look-at target.
    pub target: [f32; 3],
    /// Up vector.
    pub up: [f32; 3],
    /// Vertical FOV in degrees.
    pub fov_y_deg: f32,
}

/// Lighting configuration for a world scene.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompiledWorldLighting {
    /// Optional directional light.
    pub directional_light: Option<CompiledDirectionalLight>,
}

/// A directional light.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompiledDirectionalLight {
    /// Light direction.
    pub direction: [f32; 3],
    /// Light color (RGB).
    pub color: [f32; 3],
    /// Light intensity.
    pub intensity: f32,
}

/// Material class for scene rendering.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SceneMaterialClass {
    Opaque,
    AlphaTest,
    Transparent,
    Emissive,
    Water,
}

/// Load and compile a GLB scene from bytes.
///
/// # Arguments
/// * `glb_bytes` - The raw GLB file bytes
/// * `scene_path` - Path to the GLB file (for error messages)
/// * `scene_ref_json` - Optional JSON string with scene asset reference {path, id, label, entryCamera, compileProfile}
///
/// # Returns
/// * `Ok(JsValue)` with the compiled scene as JSON
/// * `Err(JsValue)` if loading or compilation fails
#[wasm_bindgen(js_name = loadGlbScene)]
pub fn load_glb_scene(
    glb_bytes: &[u8],
    scene_path: &str,
    scene_ref_json: Option<String>,
) -> GlbResult<JsValue> {
    // Parse scene_ref from JSON if provided
    let kernel_scene_ref = scene_ref_json
        .and_then(|json| {
            serde_json::from_str::<serde_json::Value>(&json)
                .ok()
                .and_then(|obj| {
                    let path = obj
                        .get("path")
                        .and_then(|v| v.as_str())
                        .unwrap_or(scene_path)
                        .to_string();
                    let id = obj.get("id").and_then(|v| v.as_str()).map(String::from);
                    let label = obj.get("label").and_then(|v| v.as_str()).map(String::from);
                    let entry_camera = obj
                        .get("entryCamera")
                        .and_then(|v| v.as_str())
                        .map(String::from);
                    let compile_profile = obj
                        .get("compileProfile")
                        .and_then(|v| v.as_str())
                        .map(String::from);

                    Some(SceneAssetRef {
                        path,
                        id,
                        label,
                        entry_camera,
                        compile_profile,
                    })
                })
        })
        .unwrap_or_else(|| SceneAssetRef::new(scene_path.to_string()));

    // Load the scene directly from bytes (no filesystem needed)
    let imported = load_glb_scene_from_bytes(glb_bytes, scene_path, &kernel_scene_ref)?;

    // Compile the scene
    let compiled = compile_imported_scene(&imported).map_err(|e| JsValue::from_str(&e))?;

    // Serialize to JSON and return as JsValue
    serde_json::to_string(&compiled)
        .map(|json_str| JsValue::from_str(&json_str))
        .map_err(|e| JsValue::from_str(&format!("Serialization error: {e}")))
}

/// Load a GLB scene from bytes (pure in-memory, no filesystem).
fn load_glb_scene_from_bytes(
    glb_bytes: &[u8],
    scene_path: &str,
    scene_ref: &SceneAssetRef,
) -> Result<ImportedScene, JsValue> {
    // Parse GLB directly from bytes
    let gltf = gltf::Gltf::from_slice(glb_bytes)
        .map_err(|e| JsValue::from_str(&format!("Failed to parse GLB '{}': {e}", scene_path)))?;

    let blob = gltf.blob.as_deref().ok_or_else(|| {
        JsValue::from_str(&format!(
            "GLB '{}' is missing its binary buffer chunk",
            scene_path
        ))
    })?;

    // Validate buffers are all binary (no external URIs)
    for buffer in gltf.document.buffers() {
        if !matches!(buffer.source(), gltf::buffer::Source::Bin) {
            return Err(JsValue::from_str(&format!(
                "GLB '{}' references an external buffer; scene assets must be self-contained",
                scene_path
            )));
        }
    }

    // Get the default scene or first scene
    let gltf_scene = gltf
        .document
        .default_scene()
        .or_else(|| gltf.document.scenes().next())
        .ok_or_else(|| {
            JsValue::from_str(&format!(
                "GLB '{}' does not declare a scene to import",
                scene_path
            ))
        })?;

    let scene_name = gltf_scene.name().map(str::to_owned);
    let file_stem = std::path::Path::new(scene_path)
        .file_stem()
        .and_then(|stem| stem.to_str())
        .map(str::to_owned);

    let scene_id = scene_ref
        .id
        .clone()
        .or_else(|| scene_name.clone())
        .or_else(|| file_stem.clone())
        .unwrap_or_else(|| "scene".to_string());

    let mut imported = ImportedScene {
        id: scene_id.clone(),
        source_path: std::path::PathBuf::from(scene_path),
        label: scene_ref
            .label
            .clone()
            .or_else(|| scene_name.clone())
            .or_else(|| file_stem.clone()),
        entry_camera: scene_ref.entry_camera.clone(),
        compile_profile: scene_ref
            .compile_profile
            .clone()
            .or_else(|| Some("default_world".to_string())),
        metadata: vzglyd_kernel::ImportedSceneMetadata {
            scene_name,
            extras: vzglyd_kernel::ImportedExtras::default(),
        },
        mesh_nodes: Vec::new(),
        cameras: Vec::new(),
        anchors: Vec::new(),
        directional_lights: Vec::new(),
        warnings: Vec::new(),
    };

    // Process all nodes in the scene
    for node in gltf_scene.nodes() {
        append_glb_scene_node(&mut imported, node, Mat4::IDENTITY, blob, scene_path)?;
    }

    Ok(imported)
}

/// Process a node from a GLB scene (in-memory, no filesystem).
fn append_glb_scene_node(
    imported_scene: &mut ImportedScene,
    node: gltf::Node<'_>,
    parent_transform: Mat4,
    blob: &[u8],
    scene_path: &str,
) -> Result<(), JsValue> {
    use vzglyd_kernel::ImportedSceneDirectionalLight;

    let local_transform = Mat4::from_cols_array_2d(&node.transform().matrix());
    let world_transform = parent_transform * local_transform;
    let node_name = node.name().map(str::to_owned);
    let display_name = node_name
        .clone()
        .unwrap_or_else(|| format!("node_{}", node.index()));

    let metadata = parse_imported_extras(
        node.extras(),
        &format!("node '{display_name}'"),
        &mut imported_scene.warnings,
    );
    let children: Vec<_> = node.children().collect();
    let mesh = node.mesh();
    let camera = node.camera();
    let light = node.light();

    if node.skin().is_some() {
        imported_scene.warnings.push(format!(
            "ignored skin data on node '{display_name}' while importing scene '{}'",
            imported_scene.id
        ));
    }
    if node.weights().is_some_and(|weights| !weights.is_empty()) {
        imported_scene.warnings.push(format!(
            "ignored morph target weights on node '{display_name}' while importing scene '{}'",
            imported_scene.id
        ));
    }

    if let Some(mesh) = mesh.as_ref() {
        let mesh_name = mesh.name().map(str::to_owned);
        let primitives: Vec<_> = mesh.primitives().collect();
        let primitive_count = primitives.len();
        for (primitive_index, primitive) in primitives.into_iter().enumerate() {
            let (primitive_mesh, material) = import_scene_primitive(
                primitive,
                world_transform,
                blob,
                scene_path,
                &mut imported_scene.warnings,
                &display_name,
            )?;
            imported_scene.mesh_nodes.push(ImportedSceneMeshNode {
                id: stable_scene_mesh_id(
                    &metadata,
                    node_name.as_deref(),
                    mesh_name.as_deref(),
                    node.index(),
                    primitive_index,
                    primitive_count,
                ),
                label: scene_mesh_label(
                    node_name.as_deref(),
                    mesh_name.as_deref(),
                    node.index(),
                    primitive_index,
                    primitive_count,
                ),
                node_name: node_name.clone(),
                mesh_name: mesh_name.clone(),
                node_index: node.index(),
                primitive_index,
                world_transform: world_transform.to_cols_array_2d(),
                vertices: primitive_mesh.vertices,
                indices: primitive_mesh.indices,
                material,
                metadata: metadata.clone(),
            });
        }
    }

    if let Some(camera) = camera.as_ref() {
        imported_scene.cameras.push(ImportedSceneCamera {
            id: stable_scene_camera_id(
                &metadata,
                node_name.as_deref(),
                camera.name(),
                node.index(),
            ),
            label: camera_label(node_name.as_deref(), camera.name(), node.index()),
            node_name: node_name.clone(),
            camera_name: camera.name().map(str::to_owned),
            node_index: node.index(),
            world_transform: world_transform.to_cols_array_2d(),
            projection: import_camera_projection(camera),
            metadata: metadata.clone(),
        });
    }

    if let Some(light) = light.as_ref() {
        match light.kind() {
            gltf::khr_lights_punctual::Kind::Directional => {
                let direction = world_transform.transform_vector3(Vec3::Z).normalize_or_zero();
                if direction.length_squared() == 0.0 {
                    imported_scene.warnings.push(format!(
                        "ignored directional light on node '{display_name}' with a degenerate transform while importing scene '{}'",
                        imported_scene.id
                    ));
                } else {
                    imported_scene
                        .directional_lights
                        .push(ImportedSceneDirectionalLight {
                            id: stable_scene_light_id(
                                &metadata,
                                node_name.as_deref(),
                                light.name(),
                                node.index(),
                            ),
                            label: scene_light_label(node_name.as_deref(), light.name(), node.index()),
                            node_name: node_name.clone(),
                            light_name: light.name().map(str::to_owned),
                            node_index: node.index(),
                            world_transform: world_transform.to_cols_array_2d(),
                            direction: direction.to_array(),
                            color: light.color(),
                            intensity: light.intensity(),
                            metadata: metadata.clone(),
                        });
                }
            }
            gltf::khr_lights_punctual::Kind::Point => imported_scene.warnings.push(format!(
                "ignored unsupported point light on node '{display_name}' while importing scene '{}'",
                imported_scene.id
            )),
            gltf::khr_lights_punctual::Kind::Spot { .. } => imported_scene.warnings.push(format!(
                "ignored unsupported spot light on node '{display_name}' while importing scene '{}'",
                imported_scene.id
            )),
        }
    }

    let is_anchor = metadata.vzglyd_anchor_tagged || metadata.vzglyd_id.is_some();
    if mesh.is_none() && camera.is_none() && light.is_none() && is_anchor {
        imported_scene
            .anchors
            .push(vzglyd_kernel::ImportedSceneAnchor {
                id: stable_anchor_id(&metadata, node_name.as_deref(), node.index()),
                label: anchor_label(node_name.as_deref(), node.index()),
                node_name: node_name.clone(),
                node_index: node.index(),
                world_transform: world_transform.to_cols_array_2d(),
                metadata: metadata.clone(),
            });
    } else if mesh.is_none() && camera.is_none() && light.is_none() && children.is_empty() {
        imported_scene.warnings.push(format!(
            "ignored unsupported empty node '{display_name}' while importing scene '{}'",
            imported_scene.id
        ));
    }

    for child in children {
        append_glb_scene_node(imported_scene, child, world_transform, blob, scene_path)?;
    }

    Ok(())
}

/// Import a primitive from a GLB scene (in-memory).
fn import_scene_primitive(
    primitive: gltf::Primitive<'_>,
    world_transform: Mat4,
    blob: &[u8],
    scene_path: &str,
    warnings: &mut Vec<String>,
    node_label: &str,
) -> Result<(vzglyd_kernel::ImportedMesh, ImportedSceneMaterial), JsValue> {
    if primitive.mode() != gltf::mesh::Mode::Triangles {
        return Err(JsValue::from_str(&format!(
            "GLB '{}' uses primitive mode {:?}; only triangle meshes are supported",
            scene_path,
            primitive.mode()
        )));
    }

    let reader = primitive.reader(|buffer| match buffer.source() {
        gltf::buffer::Source::Bin => Some(blob),
        gltf::buffer::Source::Uri(_) => None,
    });
    let positions: Vec<[f32; 3]> = reader
        .read_positions()
        .ok_or_else(|| {
            JsValue::from_str(&format!(
                "GLB '{}' contains a primitive without POSITION data",
                scene_path
            ))
        })?
        .collect();
    let normals: Option<Vec<[f32; 3]>> = reader.read_normals().map(Iterator::collect);
    let tex_coords: Option<Vec<[f32; 2]>> = reader
        .read_tex_coords(0)
        .map(|coords| coords.into_f32().collect());
    let vertex_colors: Option<Vec<[f32; 4]>> = reader
        .read_colors(0)
        .map(|colors| colors.into_rgba_f32().collect());
    let primitive_indices: Vec<u32> = reader
        .read_indices()
        .map(|indices| indices.into_u32().collect())
        .unwrap_or_else(|| (0..positions.len() as u32).collect());

    if positions.len() > u16::MAX as usize + 1 {
        return Err(JsValue::from_str(&format!(
            "GLB '{}' exceeds the engine's u16 static mesh index limit",
            scene_path
        )));
    }

    let material = primitive.material();
    let material_factor = material.pbr_metallic_roughness().base_color_factor();
    let material_color = (material_factor != [1.0, 1.0, 1.0, 1.0]).then_some(material_factor);
    let material_metadata = parse_imported_extras(
        material.extras(),
        &format!("material on node '{node_label}'"),
        warnings,
    );
    let normal_transform = Mat3::from_mat4(world_transform).inverse().transpose();
    let mut imported = vzglyd_kernel::ImportedMesh {
        vertices: Vec::with_capacity(positions.len()),
        indices: Vec::with_capacity(primitive_indices.len()),
    };

    for (vertex_index, position) in positions.iter().enumerate() {
        let world_position = world_transform.transform_point3(Vec3::from_array(*position));
        let transformed_normal = normals
            .as_ref()
            .and_then(|normals| normals.get(vertex_index).copied())
            .map(|normal| {
                normal_transform
                    .mul_vec3(Vec3::from_array(normal))
                    .normalize_or_zero()
                    .to_array()
            });
        let color = vertex_colors
            .as_ref()
            .and_then(|colors| colors.get(vertex_index).copied())
            .map(|vertex_color| multiply_rgba(vertex_color, material_factor))
            .or(material_color);
        imported.vertices.push(vzglyd_kernel::ImportedVertex {
            position: world_position.to_array(),
            normal: transformed_normal,
            tex_coords: tex_coords
                .as_ref()
                .and_then(|coords| coords.get(vertex_index).copied()),
            color,
        });
    }

    for index in primitive_indices {
        let final_index = u16::try_from(index).map_err(|_| {
            JsValue::from_str(&format!(
                "GLB '{}' produced an index outside the engine's u16 range",
                scene_path
            ))
        })?;
        imported.indices.push(final_index);
    }

    fill_missing_normals(&mut imported);

    Ok((
        imported,
        ImportedSceneMaterial {
            name: material.name().map(str::to_owned),
            base_color_factor: material_factor,
            class_hint: material_metadata
                .vzglyd_material
                .clone()
                .or_else(|| material.name().map(str::to_owned)),
            metadata: material_metadata,
        },
    ))
}

/// Compile an imported scene into a renderable format.
fn compile_imported_scene(imported: &ImportedScene) -> Result<CompiledScene, String> {
    let visible_mesh_nodes: Vec<&ImportedSceneMeshNode> = imported
        .mesh_nodes
        .iter()
        .filter(|node| !node.metadata.vzglyd_hidden)
        .collect();

    if visible_mesh_nodes.is_empty() {
        return Err(format!("Scene '{}' has no visible meshes", imported.id));
    }

    // Compile meshes
    let mut meshes = Vec::with_capacity(visible_mesh_nodes.len());
    for mesh_node in &visible_mesh_nodes {
        let material_class = resolve_scene_material_class(mesh_node);
        let pipeline = resolve_scene_pipeline(mesh_node, material_class);

        let vertices = mesh_node
            .vertices
            .iter()
            .map(|v| CompiledVertex {
                position: v.position,
                normal: v.normal.unwrap_or([0.0, 1.0, 0.0]),
                color: v.color.unwrap_or([1.0, 1.0, 1.0, 1.0]),
                mode: scene_material_mode(material_class),
            })
            .collect();

        meshes.push(CompiledSceneMesh {
            id: mesh_node.id.clone(),
            label: mesh_node.label.clone(),
            vertices,
            indices: mesh_node.indices.clone(),
            pipeline: match pipeline {
                PipelineKind::Opaque => "opaque".to_string(),
                PipelineKind::Transparent => "transparent".to_string(),
            },
        });
    }

    // Compile anchors
    let anchors = imported
        .anchors
        .iter()
        .map(|anchor| CompiledSceneAnchor {
            id: anchor.id.clone(),
            label: anchor.label.clone(),
            world_transform: anchor.world_transform,
            tag: anchor.metadata.vzglyd_anchor.clone(),
        })
        .collect();

    // Compile camera path
    let camera_path = compile_scene_camera_path(imported, &visible_mesh_nodes);

    // Compile lighting
    let lighting = compile_scene_lighting(imported);

    Ok(CompiledScene {
        id: imported.id.clone(),
        label: imported.label.clone(),
        meshes,
        anchors,
        camera_path,
        lighting,
    })
}

/// Resolve material class from mesh node metadata.
fn resolve_scene_material_class(mesh_node: &ImportedSceneMeshNode) -> SceneMaterialClass {
    let hint = mesh_node
        .metadata
        .vzglyd_material
        .as_deref()
        .or(mesh_node.material.metadata.vzglyd_material.as_deref())
        .or(mesh_node.material.class_hint.as_deref());

    let normalized = hint.map(|s| s.trim().to_ascii_lowercase().replace([' ', '-'], "_"));

    match normalized.as_deref() {
        Some("alpha_test") | Some("alphatest") | Some("cutout") => SceneMaterialClass::AlphaTest,
        Some("transparent") | Some("alpha_blend") | Some("blend") => {
            SceneMaterialClass::Transparent
        }
        Some("emissive") => SceneMaterialClass::Emissive,
        Some("water") => SceneMaterialClass::Water,
        Some("opaque") => SceneMaterialClass::Opaque,
        _ if mesh_node.material.base_color_factor[3] < 0.999 => SceneMaterialClass::Transparent,
        _ => SceneMaterialClass::Opaque,
    }
}

/// Resolve pipeline kind from material class.
fn resolve_scene_pipeline(
    mesh_node: &ImportedSceneMeshNode,
    material_class: SceneMaterialClass,
) -> PipelineKind {
    let default = if matches!(
        material_class,
        SceneMaterialClass::Transparent | SceneMaterialClass::Water
    ) {
        PipelineKind::Transparent
    } else {
        PipelineKind::Opaque
    };

    match mesh_node
        .metadata
        .vzglyd_pipeline
        .as_deref()
        .map(|s| s.trim().to_ascii_lowercase().replace([' ', '-'], "_"))
        .as_deref()
    {
        Some("opaque") => PipelineKind::Opaque,
        Some("transparent") => PipelineKind::Transparent,
        _ => default,
    }
}

/// Convert material class to mode value.
fn scene_material_mode(material_class: SceneMaterialClass) -> f32 {
    match material_class {
        SceneMaterialClass::Opaque => 0.0,
        SceneMaterialClass::AlphaTest => 1.0,
        SceneMaterialClass::Transparent => 2.0,
        SceneMaterialClass::Emissive => 3.0,
        SceneMaterialClass::Water => 5.0,
    }
}

const FIXED_CAMERA_DURATION_SECONDS: f32 = 1.0;
const AUTHORED_CAMERA_STEP_SECONDS: f32 = 8.0;

/// Compile camera path from imported scene.
fn compile_scene_camera_path(
    imported: &ImportedScene,
    visible_mesh_nodes: &[&ImportedSceneMeshNode],
) -> Option<CompiledCameraPath> {
    let visible_cameras: Vec<&ImportedSceneCamera> = imported
        .cameras
        .iter()
        .filter(|cam| !cam.metadata.vzglyd_hidden)
        .collect();

    // Find entry camera
    let entry_camera = imported.entry_camera.as_deref().and_then(|selector| {
        let selector = normalize_scene_token(selector);
        visible_cameras.iter().copied().find(|cam| {
            [
                Some(cam.id.as_str()),
                cam.node_name.as_deref(),
                cam.camera_name.as_deref(),
            ]
            .into_iter()
            .flatten()
            .any(|name| normalize_scene_token(name) == selector)
        })
    });

    let selected_camera = entry_camera
        .or_else(|| {
            visible_cameras
                .iter()
                .copied()
                .find(|cam| cam.metadata.vzglyd_entry_camera)
        })
        .or_else(|| visible_cameras.first().copied());

    let keyframes = match selected_camera {
        Some(camera) => {
            let keyframe = scene_camera_keyframe(camera, 0.0);
            vec![
                CameraKeyframe {
                    time: 0.0,
                    ..keyframe.clone()
                },
                CameraKeyframe {
                    time: FIXED_CAMERA_DURATION_SECONDS,
                    ..keyframe
                },
            ]
        }
        None => {
            // Generate default camera from bounds
            let bounds = compiled_scene_bounds(visible_mesh_nodes)?;
            let (min, max) = bounds;
            let center = (min + max) * 0.5;
            let extent = (max - min).max(Vec3::splat(1.0));
            let radius = extent.max_element().max(1.0);

            let keyframe = CameraKeyframe {
                time: 0.0,
                position: (center + Vec3::new(radius * 1.4, radius, radius * 1.4)).to_array(),
                target: center.to_array(),
                up: Vec3::Y.to_array(),
                fov_y_deg: 50.0,
            };
            vec![
                CameraKeyframe {
                    time: 0.0,
                    ..keyframe.clone()
                },
                CameraKeyframe {
                    time: FIXED_CAMERA_DURATION_SECONDS,
                    ..keyframe
                },
            ]
        }
    };

    // If multiple cameras, create a looping path
    let looped = visible_cameras.len() > 1 && entry_camera.is_none();
    if looped {
        let keyframes: Vec<CameraKeyframe> = visible_cameras
            .iter()
            .enumerate()
            .map(|(i, cam)| scene_camera_keyframe(cam, i as f32 * AUTHORED_CAMERA_STEP_SECONDS))
            .collect();
        Some(CompiledCameraPath {
            looped: true,
            keyframes: keyframes
                .into_iter()
                .map(|k| CompiledCameraKeyframe {
                    time: k.time,
                    position: k.position,
                    target: k.target,
                    up: k.up,
                    fov_y_deg: k.fov_y_deg,
                })
                .collect(),
        })
    } else {
        Some(CompiledCameraPath {
            looped: false,
            keyframes: keyframes
                .into_iter()
                .map(|k| CompiledCameraKeyframe {
                    time: k.time,
                    position: k.position,
                    target: k.target,
                    up: k.up,
                    fov_y_deg: k.fov_y_deg,
                })
                .collect(),
        })
    }
}

/// Normalize a scene token for comparison.
fn normalize_scene_token(value: &str) -> String {
    value.trim().to_ascii_lowercase().replace([' ', '-'], "_")
}

/// Create camera keyframe from imported camera.
fn scene_camera_keyframe(camera: &ImportedSceneCamera, time: f32) -> CameraKeyframe {
    let transform = Mat4::from_cols_array_2d(&camera.world_transform);
    let eye = transform.transform_point3(Vec3::ZERO);
    let forward = transform.transform_vector3(-Vec3::Z).normalize_or_zero();
    let up = transform.transform_vector3(Vec3::Y).normalize_or_zero();
    let target = eye
        + if forward.length_squared() > 0.0 {
            forward
        } else {
            -Vec3::Z
        };

    let fov_y_deg = match camera.projection {
        ImportedCameraProjection::Perspective { yfov_rad, .. } => yfov_rad.to_degrees(),
        ImportedCameraProjection::Orthographic { ymag, .. } => {
            (2.0 * ymag.max(0.1).atan()).to_degrees().clamp(20.0, 100.0)
        }
    };

    CameraKeyframe {
        time,
        position: eye.to_array(),
        target: target.to_array(),
        up: if up.length_squared() > 0.0 {
            up.to_array()
        } else {
            Vec3::Y.to_array()
        },
        fov_y_deg: fov_y_deg.clamp(20.0, 100.0),
    }
}

/// Calculate scene bounds from mesh nodes.
fn compiled_scene_bounds(mesh_nodes: &[&ImportedSceneMeshNode]) -> Option<(Vec3, Vec3)> {
    let mut bounds: Option<(Vec3, Vec3)> = None;
    for mesh_node in mesh_nodes {
        for vertex in &mesh_node.vertices {
            let position = Vec3::from_array(vertex.position);
            bounds = Some(match bounds {
                Some((min, max)) => (min.min(position), max.max(position)),
                None => (position, position),
            });
        }
    }
    bounds
}

/// Compile lighting from imported scene.
fn compile_scene_lighting(imported: &ImportedScene) -> Option<CompiledWorldLighting> {
    use vzglyd_kernel::ImportedSceneDirectionalLight;

    let visible_lights: Vec<&ImportedSceneDirectionalLight> = imported
        .directional_lights
        .iter()
        .filter(|light| !light.metadata.vzglyd_hidden)
        .collect();

    if visible_lights.is_empty() {
        return None;
    }

    if visible_lights.len() > 1 {
        log::warn!(
            "Scene '{}' has {} directional lights; using only the first",
            imported.id,
            visible_lights.len()
        );
    }

    let light = visible_lights[0];
    Some(CompiledWorldLighting {
        directional_light: Some(CompiledDirectionalLight {
            direction: light.direction,
            color: light.color,
            intensity: light.intensity.max(0.0).min(4.0),
        }),
    })
}

/// Encode a compiled scene mesh as a MeshAsset for the slide spec.
#[wasm_bindgen(js_name = encodeMeshAsset)]
pub fn encode_mesh_asset(mesh_json: &str) -> Result<JsValue, JsValue> {
    let mesh: CompiledSceneMesh = serde_json::from_str(mesh_json)
        .map_err(|e| JsValue::from_str(&format!("Parse error: {e}")))?;

    let mesh_asset = MeshAsset {
        vertices: mesh
            .vertices
            .iter()
            .map(|v| MeshAssetVertex {
                position: v.position,
                normal: v.normal,
                tex_coords: [0.0, 0.0],
                color: v.color,
            })
            .collect(),
        indices: mesh.indices.clone(),
    };

    let encoded = postcard::to_stdvec(&mesh_asset)
        .map_err(|e| JsValue::from_str(&format!("Encoding error: {e}")))?;

    // Return as Uint8Array
    let arr = js_sys::Uint8Array::from(encoded.as_slice());
    Ok(arr.into())
}

/// Encode scene anchors as a SceneAnchorSet.
#[wasm_bindgen(js_name = encodeSceneAnchorSet)]
pub fn encode_scene_anchor_set(scene_json: &str) -> Result<JsValue, JsValue> {
    let scene: CompiledScene = serde_json::from_str(scene_json)
        .map_err(|e| JsValue::from_str(&format!("Parse error: {e}")))?;

    let anchor_set = SceneAnchorSet {
        scene_id: scene.id.clone(),
        scene_label: scene.label.clone(),
        scene_name: scene.label.clone(),
        anchors: scene
            .anchors
            .iter()
            .map(|a| SceneAnchor {
                id: a.id.clone(),
                label: a.label.clone(),
                node_name: Some(a.label.clone()),
                tag: a.tag.clone(),
                world_transform: a.world_transform,
            })
            .collect(),
    };

    let encoded = postcard::to_stdvec(&anchor_set)
        .map_err(|e| JsValue::from_str(&format!("Encoding error: {e}")))?;

    // Return as Uint8Array
    let arr = js_sys::Uint8Array::from(encoded.as_slice());
    Ok(arr.into())
}

// ============ Helper Functions ============

/// Parse extras from a GLB element.
fn parse_imported_extras(
    extras: &gltf::json::Extras,
    context: &str,
    warnings: &mut Vec<String>,
) -> vzglyd_kernel::ImportedExtras {
    use serde_json::Value as JsonValue;

    let Some(raw) = extras.as_ref() else {
        return vzglyd_kernel::ImportedExtras::default();
    };

    let value = match serde_json::from_str::<JsonValue>(raw.get()) {
        Ok(value) => value,
        Err(error) => {
            warnings.push(format!("ignored invalid extras on {context}: {error}"));
            return vzglyd_kernel::ImportedExtras::default();
        }
    };
    let JsonValue::Object(raw) = value else {
        warnings.push(format!("ignored non-object extras on {context}"));
        return vzglyd_kernel::ImportedExtras::default();
    };

    vzglyd_kernel::ImportedExtras {
        vzglyd_id: read_extra_string(&raw, "vzglyd_id", context, warnings),
        vzglyd_pipeline: read_extra_string(&raw, "vzglyd_pipeline", context, warnings),
        vzglyd_material: read_extra_string(&raw, "vzglyd_material", context, warnings),
        vzglyd_anchor: read_extra_anchor(&raw, context, warnings),
        vzglyd_anchor_tagged: read_extra_anchor_tagged(&raw, context, warnings),
        vzglyd_hidden: read_extra_bool(&raw, "vzglyd_hidden", context, warnings),
        vzglyd_billboard: read_extra_bool(&raw, "vzglyd_billboard", context, warnings),
        vzglyd_entry_camera: read_extra_bool(&raw, "vzglyd_entry_camera", context, warnings),
        raw,
    }
}

fn read_extra_string(
    extras: &serde_json::Map<String, serde_json::Value>,
    key: &str,
    context: &str,
    warnings: &mut Vec<String>,
) -> Option<String> {
    match extras.get(key) {
        Some(serde_json::Value::String(value)) => Some(value.clone()),
        Some(other) => {
            warnings.push(format!(
                "ignored non-string extras key '{key}' on {context}: {other}"
            ));
            None
        }
        None => None,
    }
}

fn read_extra_bool(
    extras: &serde_json::Map<String, serde_json::Value>,
    key: &str,
    context: &str,
    warnings: &mut Vec<String>,
) -> bool {
    match extras.get(key) {
        Some(serde_json::Value::Bool(value)) => *value,
        Some(other) => {
            warnings.push(format!(
                "ignored non-bool extras key '{key}' on {context}: {other}"
            ));
            false
        }
        None => false,
    }
}

fn read_extra_anchor(
    extras: &serde_json::Map<String, serde_json::Value>,
    context: &str,
    warnings: &mut Vec<String>,
) -> Option<String> {
    match extras.get("vzglyd_anchor") {
        Some(serde_json::Value::String(value)) => Some(value.clone()),
        Some(serde_json::Value::Bool(true)) | None => None,
        Some(serde_json::Value::Bool(false)) => None,
        Some(other) => {
            warnings.push(format!(
                "ignored unsupported extras key 'vzglyd_anchor' on {context}: {other}"
            ));
            None
        }
    }
}

fn read_extra_anchor_tagged(
    extras: &serde_json::Map<String, serde_json::Value>,
    context: &str,
    warnings: &mut Vec<String>,
) -> bool {
    match extras.get("vzglyd_anchor") {
        Some(serde_json::Value::String(_)) => true,
        Some(serde_json::Value::Bool(value)) => *value,
        None => false,
        Some(other) => {
            warnings.push(format!(
                "ignored unsupported extras key 'vzglyd_anchor' on {context}: {other}"
            ));
            false
        }
    }
}

fn scene_mesh_label(
    node_name: Option<&str>,
    mesh_name: Option<&str>,
    node_index: usize,
    primitive_index: usize,
    primitive_count: usize,
) -> String {
    let mut label = node_name
        .or(mesh_name)
        .map(str::to_owned)
        .unwrap_or_else(|| format!("mesh_node_{node_index}"));
    if primitive_count > 1 {
        label.push_str(&format!("#primitive_{primitive_index}"));
    }
    label
}

fn stable_scene_mesh_id(
    metadata: &vzglyd_kernel::ImportedExtras,
    node_name: Option<&str>,
    mesh_name: Option<&str>,
    node_index: usize,
    primitive_index: usize,
    primitive_count: usize,
) -> String {
    let mut id = metadata
        .vzglyd_id
        .clone()
        .or_else(|| node_name.map(str::to_owned))
        .or_else(|| mesh_name.map(str::to_owned))
        .unwrap_or_else(|| format!("mesh_node_{node_index}"));
    if primitive_count > 1 {
        id.push_str(&format!("#primitive_{primitive_index}"));
    }
    id
}

fn camera_label(node_name: Option<&str>, camera_name: Option<&str>, node_index: usize) -> String {
    node_name
        .or(camera_name)
        .map(str::to_owned)
        .unwrap_or_else(|| format!("camera_node_{node_index}"))
}

fn stable_scene_camera_id(
    metadata: &vzglyd_kernel::ImportedExtras,
    node_name: Option<&str>,
    camera_name: Option<&str>,
    node_index: usize,
) -> String {
    metadata
        .vzglyd_id
        .clone()
        .or_else(|| node_name.map(str::to_owned))
        .or_else(|| camera_name.map(str::to_owned))
        .unwrap_or_else(|| format!("camera_node_{node_index}"))
}

fn scene_light_label(
    node_name: Option<&str>,
    light_name: Option<&str>,
    node_index: usize,
) -> String {
    node_name
        .or(light_name)
        .map(str::to_owned)
        .unwrap_or_else(|| format!("light_node_{node_index}"))
}

fn stable_scene_light_id(
    metadata: &vzglyd_kernel::ImportedExtras,
    node_name: Option<&str>,
    light_name: Option<&str>,
    node_index: usize,
) -> String {
    metadata
        .vzglyd_id
        .clone()
        .or_else(|| node_name.map(str::to_owned))
        .or_else(|| light_name.map(str::to_owned))
        .unwrap_or_else(|| format!("light_node_{node_index}"))
}

fn anchor_label(node_name: Option<&str>, node_index: usize) -> String {
    node_name
        .map(str::to_owned)
        .unwrap_or_else(|| format!("anchor_node_{node_index}"))
}

fn stable_anchor_id(
    metadata: &vzglyd_kernel::ImportedExtras,
    node_name: Option<&str>,
    node_index: usize,
) -> String {
    metadata
        .vzglyd_id
        .clone()
        .or_else(|| node_name.map(str::to_owned))
        .unwrap_or_else(|| format!("anchor_node_{node_index}"))
}

fn import_camera_projection(camera: &gltf::Camera<'_>) -> ImportedCameraProjection {
    match camera.projection() {
        gltf::camera::Projection::Perspective(perspective) => {
            ImportedCameraProjection::Perspective {
                aspect_ratio: perspective.aspect_ratio(),
                yfov_rad: perspective.yfov(),
                znear: perspective.znear(),
                zfar: perspective.zfar(),
            }
        }
        gltf::camera::Projection::Orthographic(orthographic) => {
            ImportedCameraProjection::Orthographic {
                xmag: orthographic.xmag(),
                ymag: orthographic.ymag(),
                znear: orthographic.znear(),
                zfar: orthographic.zfar(),
            }
        }
    }
}

fn fill_missing_normals(imported: &mut vzglyd_kernel::ImportedMesh) {
    if imported
        .vertices
        .iter()
        .all(|vertex| vertex.normal.is_some())
    {
        return;
    }

    let mut accum = vec![Vec3::ZERO; imported.vertices.len()];
    for triangle in imported.indices.chunks_exact(3) {
        let i0 = triangle[0] as usize;
        let i1 = triangle[1] as usize;
        let i2 = triangle[2] as usize;
        let p0 = Vec3::from_array(imported.vertices[i0].position);
        let p1 = Vec3::from_array(imported.vertices[i1].position);
        let p2 = Vec3::from_array(imported.vertices[i2].position);
        let face_normal = (p1 - p0).cross(p2 - p0);
        accum[i0] += face_normal;
        accum[i1] += face_normal;
        accum[i2] += face_normal;
    }

    for (vertex, sum) in imported.vertices.iter_mut().zip(accum) {
        if vertex.normal.is_none() {
            vertex.normal = Some(sum.normalize_or_zero().to_array());
        }
    }
}

fn multiply_rgba(a: [f32; 4], b: [f32; 4]) -> [f32; 4] {
    [a[0] * b[0], a[1] * b[1], a[2] * b[2], a[3] * b[3]]
}
