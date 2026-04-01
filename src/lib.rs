//! VZGLYD Web Host
//!
//! This is the web host implementation for the VZGLYD display engine.
//! It integrates the platform-agnostic kernel with:
//! - WebGPU for GPU rendering
//! - Browser WASM for slide instantiation
//! - fetch() for asset loading

use wasm_bindgen::prelude::*;
use web_sys::{Window, HtmlCanvasElement};
use js_sys::Uint8Array;

mod gpu;
mod wasm;
mod assets;
mod utils;

/// Web host that implements the kernel Host trait.
#[wasm_bindgen]
pub struct WebHost {
    window: Window,
    device: JsValue,
    queue: JsValue,
    canvas: HtmlCanvasElement,
    engine: Option<vzglyd_kernel::Engine>,
    last_time: f64,
}

/// Temporary host wrapper to avoid borrow issues.
struct HostWrapper<'a> {
    host: &'a mut WebHost,
}

impl<'a> vzglyd_kernel::Host for HostWrapper<'a> {
    fn request_data(&mut self, _key: &str) -> Option<Vec<u8>> {
        // Fetch-based loading is async, so we return None initially
        // Full implementation would use wasm_bindgen_futures
        None
    }
    
    fn submit_render_commands(&mut self, _cmds: &[vzglyd_kernel::RenderCommand]) {
        // Translate RenderCommand to WebGPU calls via web-sys
        // Stub for now
    }
    
    fn log(&mut self, level: vzglyd_kernel::LogLevel, msg: &str) {
        match level {
            vzglyd_kernel::LogLevel::Debug => web_sys::console::debug_1(&msg.into()),
            vzglyd_kernel::LogLevel::Info => web_sys::console::info_1(&msg.into()),
            vzglyd_kernel::LogLevel::Warn => web_sys::console::warn_1(&msg.into()),
            vzglyd_kernel::LogLevel::Error => web_sys::console::error_1(&msg.into()),
        }
    }
    
    fn now(&self) -> f32 {
        (js_sys::Date::now() / 1000.0) as f32
    }
}

#[wasm_bindgen]
impl WebHost {
    /// Creates a new web host.
    #[wasm_bindgen(constructor)]
    pub fn new(canvas: HtmlCanvasElement, device: JsValue) -> Result<WebHost, JsValue> {
        let window = web_sys::window().ok_or("No window available")?;
        let queue = device.clone();  // Simplified - queue comes from device
        
        let mut host = WebHost {
            window,
            device,
            queue,
            canvas,
            engine: Some(vzglyd_kernel::Engine::new()),
            last_time: js_sys::Date::now(),
        };
        
        // Initialize engine with host wrapper
        if let Some(mut engine) = host.engine.take() {
            let mut wrapper = HostWrapper { host: &mut host };
            engine.init(&mut wrapper);
            host.engine = Some(engine);
        }
        
        Ok(host)
    }
    
    /// Loads a .vzglyd slide bundle.
    #[wasm_bindgen]
    pub fn load_slide(&mut self, bytes: Uint8Array) -> Result<(), JsValue> {
        // TODO: Extract archive, load WASM, initialize slide
        // For now, just log that we received the bytes
        web_sys::console::log_1(&format!("Received {} bytes for slide", bytes.length()).into());
        Ok(())
    }
    
    /// Updates the engine for a new frame.
    #[wasm_bindgen]
    pub fn frame(&mut self, timestamp: f64) -> Result<(), JsValue> {
        let dt = ((timestamp - self.last_time) / 1000.0) as f32;
        self.last_time = timestamp;
        
        let input = vzglyd_kernel::EngineInput {
            dt,
            events: vec![],
        };
        
        // Update engine using host wrapper to avoid borrow issues
        if let Some(mut engine) = self.engine.take() {
            let mut wrapper = HostWrapper { host: self };
            let _output = engine.update(&mut wrapper, input);
            self.engine = Some(engine);
        }
        
        Ok(())
    }
}

/// Initializes the web host and starts the render loop.
#[wasm_bindgen(start)]
pub fn main() -> Result<(), JsValue> {
    console_error_panic_hook::set_once();
    wasm_logger::init(wasm_logger::Config::default());
    
    log::info!("VZGLYD Web Host starting...");
    
    Ok(())
}
