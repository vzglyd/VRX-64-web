//! Bundle loader constants shared with browser bridge logic.

/// Default bundle entry name for the main slide module.
pub const PACKAGE_WASM_NAME: &str = "slide.wasm";
/// Optional sidecar entry name.
pub const PACKAGE_SIDECAR_NAME: &str = "sidecar.wasm";
/// Primary manifest entry name.
pub const PACKAGE_MANIFEST_NAME: &str = "manifest.json";
/// Expected archive extension.
pub const PACKAGE_ARCHIVE_EXTENSION: &str = "vzglyd";
