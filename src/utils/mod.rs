//! Utility helpers.

use std::sync::Once;

static INIT: Once = Once::new();

/// Initialize panic hook + logger once per page lifecycle.
pub fn init_logging() {
    INIT.call_once(|| {
        console_error_panic_hook::set_once();
        wasm_logger::init(wasm_logger::Config::default());
    });
}
