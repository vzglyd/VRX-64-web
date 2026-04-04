use js_sys::Uint8Array;
use wasm_bindgen::prelude::*;
use web_sys::HtmlCanvasElement;

#[wasm_bindgen(raw_module = "../js/engine_bridge.js")]
extern "C" {
    #[wasm_bindgen(js_name = EngineBridge)]
    type JsEngineBridge;

    #[wasm_bindgen(constructor)]
    fn new(canvas: HtmlCanvasElement, config: JsValue) -> JsEngineBridge;

    #[wasm_bindgen(method, catch, js_name = loadBundle)]
    async fn load_bundle(
        this: &JsEngineBridge,
        bytes: Uint8Array,
        runtime_options: JsValue,
    ) -> Result<JsValue, JsValue>;

    #[wasm_bindgen(method, catch)]
    fn frame(this: &JsEngineBridge, timestamp_ms: f64) -> Result<JsValue, JsValue>;

    #[wasm_bindgen(method)]
    fn teardown(this: &JsEngineBridge);

    #[wasm_bindgen(method)]
    fn stats(this: &JsEngineBridge) -> JsValue;

    #[wasm_bindgen(method, js_name = startTraceCapture)]
    fn start_trace_capture(this: &JsEngineBridge, extra_metadata: JsValue) -> bool;

    #[wasm_bindgen(method, js_name = stopTraceCapture)]
    fn stop_trace_capture(this: &JsEngineBridge, extra_metadata: JsValue) -> bool;

    #[wasm_bindgen(method, js_name = exportTrace)]
    fn export_trace(this: &JsEngineBridge) -> JsValue;

    #[wasm_bindgen(method, js_name = downloadTrace)]
    fn download_trace(this: &JsEngineBridge, filename: JsValue) -> bool;
}

/// Thin Rust wrapper around the browser-side runtime bridge.
pub struct RuntimeBridge {
    inner: JsEngineBridge,
}

impl RuntimeBridge {
    pub fn new(canvas: HtmlCanvasElement, config: Option<JsValue>) -> Self {
        let config = config.unwrap_or_else(|| JsValue::NULL);
        Self {
            inner: JsEngineBridge::new(canvas, config),
        }
    }

    pub async fn load_bundle(
        &self,
        bytes: Uint8Array,
        runtime_options: Option<JsValue>,
    ) -> Result<(), JsValue> {
        let runtime_options = runtime_options.unwrap_or_else(|| JsValue::NULL);
        self.inner
            .load_bundle(bytes, runtime_options)
            .await
            .map(|_| ())
    }

    pub fn frame(&self, timestamp_ms: f64) -> Result<(), JsValue> {
        self.inner.frame(timestamp_ms).map(|_| ())
    }

    pub fn teardown(&self) {
        self.inner.teardown();
    }

    pub fn stats(&self) -> JsValue {
        self.inner.stats()
    }

    pub fn start_trace_capture(&self, extra_metadata: Option<JsValue>) -> bool {
        let extra_metadata = extra_metadata.unwrap_or_else(|| JsValue::NULL);
        self.inner.start_trace_capture(extra_metadata)
    }

    pub fn stop_trace_capture(&self, extra_metadata: Option<JsValue>) -> bool {
        let extra_metadata = extra_metadata.unwrap_or_else(|| JsValue::NULL);
        self.inner.stop_trace_capture(extra_metadata)
    }

    pub fn export_trace(&self) -> JsValue {
        self.inner.export_trace()
    }

    pub fn download_trace(&self, filename: Option<&str>) -> bool {
        let filename = filename
            .map(JsValue::from_str)
            .unwrap_or_else(|| JsValue::UNDEFINED);
        self.inner.download_trace(filename)
    }
}
