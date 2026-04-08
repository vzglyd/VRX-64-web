use bytemuck::cast_slice;
use js_sys::{Date, Reflect, Uint8Array};
use wasm_bindgen::prelude::*;
use web_sys::HtmlCanvasElement;
use vzglyd_kernel::{build_screensaver_geometry, ScreensaverFrameState};

#[wasm_bindgen(raw_module = "../js/slide_runtime.js")]
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

    /// Returns `{ width: number, height: number }` for the canvas backing size.
    #[wasm_bindgen(method, js_name = getSurfaceSize)]
    fn get_surface_size(this: &JsEngineBridge) -> JsValue;

    /// Returns the current slide name string, or `null` if none is loaded.
    #[wasm_bindgen(method, js_name = getSlideName)]
    fn get_slide_name(this: &JsEngineBridge) -> JsValue;

    /// Initialize the HUD font atlas in the JS renderer.
    ///
    /// `atlas_bytes` is a flat RGBA8 pixel buffer of dimensions
    /// `atlas_width × atlas_height`. Call once after the renderer is ready.
    #[wasm_bindgen(method, js_name = initHud)]
    fn init_hud(
        this: &JsEngineBridge,
        atlas_bytes: Uint8Array,
        atlas_width: u32,
        atlas_height: u32,
    );

    /// Push updated HUD geometry to the JS renderer for this frame.
    ///
    /// `verts_bytes` is packed [`OverlayVertex`] data (stride 40 bytes).
    /// `idxs_bytes` is a packed `u16` index buffer.
    #[wasm_bindgen(method, js_name = applyHudGeometry)]
    fn apply_hud_geometry(
        this: &JsEngineBridge,
        verts_bytes: Uint8Array,
        idxs_bytes: Uint8Array,
    );
}

/// Thin Rust wrapper around the browser-side runtime bridge.
pub struct RuntimeBridge {
    inner: JsEngineBridge,
    glyph_map: std::collections::HashMap<char, [f32; 4]>,
    hud_initialized: bool,
    /// Screensaver timeout in seconds. `None` means disabled.
    screensaver_timeout_secs: Option<f32>,
    /// How long the screensaver runs before the playlist resumes.
    screensaver_duration_secs: f32,
    /// Accumulated display time since the last screensaver reset.
    display_elapsed_secs: f32,
    /// Elapsed time inside the current screensaver run.
    screensaver_elapsed_secs: f32,
    /// Whether the screensaver is currently active.
    screensaver_active: bool,
    /// Timestamp of the previous frame, used to compute `dt`.
    last_timestamp_ms: Option<f64>,
}

impl RuntimeBridge {
    pub fn new(canvas: HtmlCanvasElement, config: Option<JsValue>) -> Self {
        let config = config.unwrap_or_else(|| JsValue::NULL);
        Self {
            inner: JsEngineBridge::new(canvas, config),
            glyph_map: std::collections::HashMap::new(),
            hud_initialized: false,
            screensaver_timeout_secs: None,
            screensaver_duration_secs: 60.0,
            display_elapsed_secs: 0.0,
            screensaver_elapsed_secs: 0.0,
            screensaver_active: false,
            last_timestamp_ms: None,
        }
    }

    /// Configure or disable the screensaver.
    ///
    /// `timeout_secs` is how long the display runs before activating the screensaver.
    /// `duration_secs` is how long the screensaver shows before the playlist resumes.
    /// Set `timeout_secs` to `None` to disable the screensaver entirely.
    pub fn set_screensaver_config(&mut self, timeout_secs: Option<f32>, duration_secs: f32) {
        self.screensaver_timeout_secs = timeout_secs;
        self.screensaver_duration_secs = duration_secs;
        self.display_elapsed_secs = 0.0;
        self.screensaver_elapsed_secs = 0.0;
        self.screensaver_active = false;
        self.last_timestamp_ms = None;
    }

    /// Ensure the font atlas is uploaded and return the current canvas dimensions.
    ///
    /// Returns `None` if the canvas has zero size (not yet ready).
    fn ensure_hud_ready(&mut self) -> Option<(u32, u32)> {
        if !self.hud_initialized {
            let (pixels, atlas_w, atlas_h, glyph_map) = vzglyd_kernel::build_font_atlas_pixels();
            let atlas_bytes = Uint8Array::from(pixels.as_slice());
            self.inner.init_hud(atlas_bytes, atlas_w, atlas_h);
            self.glyph_map = glyph_map;
            self.hud_initialized = true;
        }
        let size = self.inner.get_surface_size();
        let sw = js_f64(&size, "width").unwrap_or(0.0) as u32;
        let sh = js_f64(&size, "height").unwrap_or(0.0) as u32;
        if sw == 0 || sh == 0 { None } else { Some((sw, sh)) }
    }

    /// Push normal HUD geometry (border, footer, slide title, clock).
    fn push_hud(&mut self) {
        let Some((sw, sh)) = self.ensure_hud_ready() else { return };

        let slide_name_js = self.inner.get_slide_name();
        let slide_name = slide_name_js.as_string();
        let clock_str = hud_clock_str();
        let (verts, idxs) = vzglyd_kernel::build_hud_geometry(
            &self.glyph_map,
            sw,
            sh,
            slide_name.as_deref(),
            &clock_str,
        );
        let verts_bytes = Uint8Array::from(cast_slice::<_, u8>(&verts));
        let idxs_bytes = Uint8Array::from(cast_slice::<_, u8>(&idxs));
        self.inner.apply_hud_geometry(verts_bytes, idxs_bytes);
    }

    /// Push screensaver geometry (full-screen black + drifting "Intermission" + countdown).
    fn push_screensaver_geometry(&mut self, state: &ScreensaverFrameState) {
        let Some((sw, sh)) = self.ensure_hud_ready() else { return };

        let (verts, idxs) = build_screensaver_geometry(
            &self.glyph_map,
            sw,
            sh,
            state.elapsed_secs,
            state.remaining_secs,
        );
        let verts_bytes = Uint8Array::from(cast_slice::<_, u8>(&verts));
        let idxs_bytes = Uint8Array::from(cast_slice::<_, u8>(&idxs));
        self.inner.apply_hud_geometry(verts_bytes, idxs_bytes);
    }

    /// Advance the screensaver state machine and return the current state if active.
    fn tick_screensaver(&mut self, dt: f32) -> Option<ScreensaverFrameState> {
        let timeout = self.screensaver_timeout_secs?;
        let duration = self.screensaver_duration_secs;

        if self.screensaver_active {
            self.screensaver_elapsed_secs += dt;
            if self.screensaver_elapsed_secs >= duration {
                self.screensaver_active = false;
                self.screensaver_elapsed_secs = 0.0;
                self.display_elapsed_secs = 0.0;
            }
        } else {
            self.display_elapsed_secs += dt;
            if self.display_elapsed_secs >= timeout {
                self.screensaver_active = true;
                self.screensaver_elapsed_secs = 0.0;
            }
        }

        if self.screensaver_active {
            Some(ScreensaverFrameState {
                remaining_secs: (duration - self.screensaver_elapsed_secs).max(0.0),
                total_secs: duration,
                elapsed_secs: self.screensaver_elapsed_secs,
            })
        } else {
            None
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

    pub fn frame(&mut self, timestamp_ms: f64) -> Result<(), JsValue> {
        // Compute dt from the timestamp delta, clamped to avoid large jumps on tab resume.
        let dt = if let Some(prev) = self.last_timestamp_ms {
            ((timestamp_ms - prev) / 1000.0).clamp(0.0, 0.5) as f32
        } else {
            0.0
        };
        self.last_timestamp_ms = Some(timestamp_ms);

        // Advance the screensaver state machine and push appropriate geometry.
        let ss_state = self.tick_screensaver(dt);
        if let Some(ref state) = ss_state {
            self.push_screensaver_geometry(state);
        } else {
            self.push_hud();
        }

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

// ── Helpers ───────────────────────────────────────────────────────────────────

/// Extract a named numeric field from a JS object.
fn js_f64(obj: &JsValue, key: &str) -> Option<f64> {
    Reflect::get(obj, &JsValue::from_str(key))
        .ok()
        .and_then(|v| v.as_f64())
}

/// Returns the current local wall-clock time as `"HH:MM:SS"` using the JS
/// `Date` API (which reports local time, including DST).
fn hud_clock_str() -> String {
    let d = Date::new_0();
    format!(
        "{:02}:{:02}:{:02}",
        d.get_hours() as u32,
        d.get_minutes() as u32,
        d.get_seconds() as u32,
    )
}
