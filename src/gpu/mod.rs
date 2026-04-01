//! WebGPU context and rendering.

use wasm_bindgen::prelude::*;

/// WebGPU context.
pub struct WebGpuContext {
    pub device: JsValue,
    pub queue: JsValue,
}

impl WebGpuContext {
    /// Creates a new WebGPU context.
    pub fn new(device: JsValue) -> Self {
        let queue = device.clone();  // Simplified - queue is from device
        Self { device, queue }
    }
}

/// Offscreen render target.
pub struct OffscreenTarget {
    pub texture: JsValue,
    pub view: JsValue,
}

/// Render pipeline handle.
pub struct Pipeline {
    pub pipeline: JsValue,
}
