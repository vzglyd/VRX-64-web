//! Asset and manifest helpers for browser bundles.

mod archive;
mod manifest;

pub use archive::looks_like_zip_archive;
pub use manifest::{ManifestValidationError, SlideManifest};
