//! VZGLYD Web Host
//!
//! Browser host for VZGLYD slide bundles.
//! The crate exposes a Rust `WebHost` API but delegates browser-specific
//! WebAssembly and rendering details to JS bridge modules in `web-preview/js`.

use js_sys::Uint8Array;
use wasm_bindgen::prelude::*;
use web_sys::HtmlCanvasElement;

mod app;
pub mod assets;
pub mod gpu;
pub mod render;
pub mod slide;
pub mod slide_loader;
mod utils;
mod wasm;

/// Browser host entry point exported to JavaScript.
#[wasm_bindgen]
pub struct WebHost {
    app: app::WebHostApp,
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
        let app = app::WebHostApp::new(canvas, host_config)?;
        Ok(Self { app })
    }

    /// Load a `.vzglyd` bundle from bytes.
    #[wasm_bindgen(js_name = loadBundle)]
    pub async fn load_bundle(
        &mut self,
        bytes: Uint8Array,
        runtime_options: Option<JsValue>,
    ) -> Result<(), JsValue> {
        self.app.load_bundle(bytes, runtime_options).await
    }

    /// Backward-compatible alias used by older page shells.
    #[wasm_bindgen(js_name = loadSlide)]
    pub async fn load_slide(
        &mut self,
        bytes: Uint8Array,
        runtime_options: Option<JsValue>,
    ) -> Result<(), JsValue> {
        self.load_bundle(bytes, runtime_options).await
    }

    /// Advance one frame.
    pub fn frame(&mut self, timestamp_ms: f64) -> Result<(), JsValue> {
        self.app.frame(timestamp_ms)
    }

    /// Dispose runtime resources.
    pub fn teardown(&mut self) {
        self.app.teardown();
    }

    /// Snapshot host/runtime stats as a JS object.
    pub fn stats(&self) -> JsValue {
        self.app.stats()
    }

    /// Start capturing a browser trace in memory.
    #[wasm_bindgen(js_name = startTraceCapture)]
    pub fn start_trace_capture(&self, extra_metadata: Option<JsValue>) -> bool {
        self.app.start_trace_capture(extra_metadata)
    }

    /// Stop the active browser trace capture.
    #[wasm_bindgen(js_name = stopTraceCapture)]
    pub fn stop_trace_capture(&self, extra_metadata: Option<JsValue>) -> bool {
        self.app.stop_trace_capture(extra_metadata)
    }

    /// Export the current trace snapshot as a JS object.
    #[wasm_bindgen(js_name = exportTrace)]
    pub fn export_trace(&self) -> JsValue {
        self.app.export_trace()
    }

    /// Download the current trace snapshot as a Perfetto JSON artifact.
    #[wasm_bindgen(js_name = downloadTrace)]
    pub fn download_trace(&self, filename: Option<String>) -> bool {
        self.app.download_trace(filename.as_deref())
    }
}

/// wasm entry hook.
#[wasm_bindgen(start)]
pub fn main() -> Result<(), JsValue> {
    utils::init_logging();
    Ok(())
}
