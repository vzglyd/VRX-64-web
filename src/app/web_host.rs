use js_sys::Uint8Array;
use wasm_bindgen::prelude::*;
use web_sys::HtmlCanvasElement;

use crate::wasm::RuntimeBridge;

/// Top-level runtime orchestrator used by `WebHost`.
pub struct WebHostApp {
    bridge: RuntimeBridge,
}

impl WebHostApp {
    pub fn new(canvas: HtmlCanvasElement, host_config: Option<JsValue>) -> Result<Self, JsValue> {
        Ok(Self {
            bridge: RuntimeBridge::new(canvas, host_config),
        })
    }

    pub async fn load_bundle(
        &mut self,
        bytes: Uint8Array,
        runtime_options: Option<JsValue>,
    ) -> Result<(), JsValue> {
        self.bridge.load_bundle(bytes, runtime_options).await
    }

    pub fn frame(&mut self, timestamp_ms: f64) -> Result<(), JsValue> {
        self.bridge.frame(timestamp_ms)
    }

    pub fn teardown(&mut self) {
        self.bridge.teardown();
    }

    pub fn stats(&self) -> JsValue {
        self.bridge.stats()
    }

    pub fn start_trace_capture(&self, extra_metadata: Option<JsValue>) -> bool {
        self.bridge.start_trace_capture(extra_metadata)
    }

    pub fn stop_trace_capture(&self, extra_metadata: Option<JsValue>) -> bool {
        self.bridge.stop_trace_capture(extra_metadata)
    }

    pub fn export_trace(&self) -> JsValue {
        self.bridge.export_trace()
    }

    pub fn download_trace(&self, filename: Option<&str>) -> bool {
        self.bridge.download_trace(filename)
    }
}
