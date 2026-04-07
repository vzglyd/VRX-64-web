//! VZGLYD Web Host
//!
//! Browser host for VZGLYD slide bundles.
//! The crate exposes a Rust `WebHost` API but delegates browser-specific
//! WebAssembly and rendering details to JS bridge modules in `web-preview/js`.

use js_sys::Uint8Array;
use wasm_bindgen::prelude::*;
use web_sys::HtmlCanvasElement;

pub mod assets;
pub mod slide;
mod utils;
mod wasm;

/// Browser host entry point exported to JavaScript.
#[wasm_bindgen]
pub struct WebHost {
    bridge: wasm::RuntimeBridge,
}

#[wasm_bindgen]
impl WebHost {
    /// Create a new host bound to a canvas.
    ///
    /// `host_config` is an optional JS object consumed by the JS bridge.
    #[wasm_bindgen(constructor)]
    pub fn new(
        canvas: HtmlCanvasElement,
        host_config: Option<JsValue>,
    ) -> Result<WebHost, JsValue> {
        utils::init_logging();
        Ok(Self {
            bridge: wasm::RuntimeBridge::new(canvas, host_config),
        })
    }

    /// Load a `.vzglyd` bundle from bytes.
    #[wasm_bindgen(js_name = loadBundle)]
    pub async fn load_bundle(
        &mut self,
        bytes: Uint8Array,
        runtime_options: Option<JsValue>,
    ) -> Result<(), JsValue> {
        self.bridge.load_bundle(bytes, runtime_options).await
    }

    /// Backward-compatible alias used by older page shells.
    #[wasm_bindgen(js_name = loadSlide)]
    pub async fn load_slide(
        &mut self,
        bytes: Uint8Array,
        runtime_options: Option<JsValue>,
    ) -> Result<(), JsValue> {
        self.bridge.load_bundle(bytes, runtime_options).await
    }

    /// Advance one frame.
    pub fn frame(&mut self, timestamp_ms: f64) -> Result<(), JsValue> {
        self.bridge.frame(timestamp_ms)
    }

    /// Dispose runtime resources.
    pub fn teardown(&mut self) {
        self.bridge.teardown();
    }

    /// Snapshot host/runtime stats as a JS object.
    pub fn stats(&self) -> JsValue {
        self.bridge.stats()
    }

    /// Start capturing a browser trace in memory.
    #[wasm_bindgen(js_name = startTraceCapture)]
    pub fn start_trace_capture(&self, extra_metadata: Option<JsValue>) -> bool {
        self.bridge.start_trace_capture(extra_metadata)
    }

    /// Stop the active browser trace capture.
    #[wasm_bindgen(js_name = stopTraceCapture)]
    pub fn stop_trace_capture(&self, extra_metadata: Option<JsValue>) -> bool {
        self.bridge.stop_trace_capture(extra_metadata)
    }

    /// Export the current trace snapshot as a JS object.
    #[wasm_bindgen(js_name = exportTrace)]
    pub fn export_trace(&self) -> JsValue {
        self.bridge.export_trace()
    }

    /// Download the current trace snapshot as a Perfetto JSON artifact.
    #[wasm_bindgen(js_name = downloadTrace)]
    pub fn download_trace(&self, filename: Option<String>) -> bool {
        self.bridge.download_trace(filename.as_deref())
    }
}

/// Minimum display duration exposed to JS so it isn't hardcoded in multiple places.
#[wasm_bindgen(js_name = minDisplayDurationSeconds)]
pub fn min_display_duration_seconds() -> u32 {
    vzglyd_kernel::manifest::MIN_DISPLAY_DURATION_SECONDS
}

/// Maximum display duration exposed to JS so it isn't hardcoded in multiple places.
#[wasm_bindgen(js_name = maxDisplayDurationSeconds)]
pub fn max_display_duration_seconds() -> u32 {
    vzglyd_kernel::manifest::MAX_DISPLAY_DURATION_SECONDS
}

/// wasm entry hook.
#[wasm_bindgen(start)]
pub fn main() -> Result<(), JsValue> {
    utils::init_logging();
    Ok(())
}
