//! Browser GPU backend marker types.

/// Supported browser backend.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Backend {
    WebGpu,
}

impl Backend {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::WebGpu => "webgpu",
        }
    }
}
