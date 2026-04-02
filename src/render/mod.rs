//! Render subsystem shims.

/// Render status reported by the JS bridge.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RenderStatus {
    Ready,
    Uninitialized,
}
