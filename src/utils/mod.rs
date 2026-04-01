//! Web utilities.

use wasm_bindgen::prelude::*;

/// Returns the current time in seconds.
pub fn now_secs() -> f64 {
    js_sys::Date::now() / 1000.0
}
