//! Slide wire helpers and GLB scene loading.

mod glb_loader;
mod wire;

pub use glb_loader::{
    CompiledCameraKeyframe, CompiledCameraPath, CompiledDirectionalLight, CompiledScene,
    CompiledSceneAnchor, CompiledSceneMesh, CompiledVertex, CompiledWorldLighting,
    encode_mesh_asset, encode_scene_anchor_set, load_glb_scene,
};

pub use wire::{WIRE_VERSION, validate_wire_blob};
