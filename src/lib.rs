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

    /// Configure the screensaver / burn-in protection.
    ///
    /// `timeout_secs` — display seconds before the screensaver activates.
    /// `duration_secs` — how long the screensaver runs before the playlist resumes.
    /// Call with `timeout_secs = 0.0` to disable.
    #[wasm_bindgen(js_name = setScreensaverConfig)]
    pub fn set_screensaver_config(&mut self, timeout_secs: f32, duration_secs: f32) {
        let config = if timeout_secs > 0.0 { Some(timeout_secs) } else { None };
        self.bridge.set_screensaver_config(config, duration_secs);
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

// ── Management API ─────────────────────────────────────────────────────────────

/// Hydrate a playlist entry against its manifest and playlist defaults.
///
/// All three arguments are JSON strings matching the Rust types:
/// - `entry_json`: serialized [`PlaylistEntry`]
/// - `manifest_json`: optional serialized [`SlideManifest`] (pass `undefined`/`null` if unavailable)
/// - `defaults_json`: serialized [`PlaylistDefaults`]
///
/// Returns a serialized [`HydratedPlaylistEntry`] as a JS object, or throws on parse error.
#[wasm_bindgen(js_name = hydratePlaylistEntry)]
pub fn hydrate_playlist_entry(
    entry_json: &str,
    manifest_json: Option<String>,
    defaults_json: &str,
) -> Result<JsValue, JsValue> {
    use vzglyd_kernel::schedule::{PlaylistDefaults, PlaylistEntry};
    use vzglyd_kernel::manifest::SlideManifest;
    use vzglyd_kernel::management::hydrate_entry;

    let entry: PlaylistEntry = serde_json::from_str(entry_json)
        .map_err(|e| JsValue::from_str(&format!("invalid entry JSON: {e}")))?;

    let manifest: Option<SlideManifest> = manifest_json
        .as_deref()
        .map(|s| serde_json::from_str(s))
        .transpose()
        .map_err(|e| JsValue::from_str(&format!("invalid manifest JSON: {e}")))?;

    let defaults: PlaylistDefaults = serde_json::from_str(defaults_json)
        .map_err(|e| JsValue::from_str(&format!("invalid defaults JSON: {e}")))?;

    let hydrated = hydrate_entry(&entry, manifest.as_ref(), &defaults, vzglyd_kernel::ENGINE_DEFAULT_DURATION_SECS);
    let json = serde_json::to_string(&hydrated)
        .map_err(|e| JsValue::from_str(&format!("serialization error: {e}")))?;
    js_sys::JSON::parse(&json).map_err(|e| e)
}

/// Validate playlist entry params against a manifest's param schema.
///
/// - `params_json`: serialized `serde_json::Value` (the params object), or `"null"`
/// - `schema_json`: serialized [`ManifestParamsSchema`]
///
/// Returns an array of error strings (empty = valid). Throws on parse error.
#[wasm_bindgen(js_name = validateEntryParams)]
pub fn validate_entry_params(params_json: &str, schema_json: &str) -> Result<JsValue, JsValue> {
    use vzglyd_kernel::manifest::ManifestParamsSchema;
    use vzglyd_kernel::management::validate_params;

    let params: Option<serde_json::Value> = serde_json::from_str(params_json)
        .map_err(|e| JsValue::from_str(&format!("invalid params JSON: {e}")))?;

    let schema: ManifestParamsSchema = serde_json::from_str(schema_json)
        .map_err(|e| JsValue::from_str(&format!("invalid schema JSON: {e}")))?;

    let errors = validate_params(params.as_ref(), Some(&schema));
    let json = serde_json::to_string(&errors)
        .map_err(|e| JsValue::from_str(&format!("serialization error: {e}")))?;
    js_sys::JSON::parse(&json).map_err(|e| e)
}

/// Parse a `secrets.json` string and return an object containing only the key names.
///
/// Values are never exposed to the browser. Returns `{ keys: string[] }`.
#[wasm_bindgen(js_name = parseSecretsJson)]
pub fn parse_secrets_json(json: &str) -> Result<JsValue, JsValue> {
    use vzglyd_kernel::management::SecretsStore;

    let store = SecretsStore::from_json(json)
        .map_err(|e| JsValue::from_str(&format!("invalid secrets JSON: {e}")))?;

    let keys: Vec<&str> = store.keys();
    let out = serde_json::json!({ "keys": keys });
    let out_str = serde_json::to_string(&out)
        .map_err(|e| JsValue::from_str(&format!("serialization error: {e}")))?;
    js_sys::JSON::parse(&out_str).map_err(|e| e)
}

/// wasm entry hook.
#[wasm_bindgen(start)]
pub fn main() -> Result<(), JsValue> {
    utils::init_logging();
    Ok(())
}
