//! Slide wire helpers and GLB scene loading.

mod glb_loader;
mod wire;

pub use glb_loader::{
    load_glb_scene, encode_mesh_asset, encode_scene_anchor_set,
    CompiledScene, CompiledSceneMesh, CompiledVertex, CompiledSceneAnchor,
    CompiledCameraPath, CompiledCameraKeyframe, CompiledWorldLighting,
    CompiledDirectionalLight,
};

pub use wire::{WIRE_VERSION, validate_wire_blob};
