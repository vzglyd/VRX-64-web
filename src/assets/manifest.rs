use serde::{Deserialize, Serialize};

pub const MIN_DISPLAY_DURATION_SECONDS: u32 = 1;
pub const MAX_DISPLAY_DURATION_SECONDS: u32 = 300;

/// Browser-visible package manifest.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct SlideManifest {
    pub name: Option<String>,
    pub version: Option<String>,
    pub author: Option<String>,
    pub description: Option<String>,
    pub abi_version: Option<u32>,
    pub scene_space: Option<String>,
    pub display: Option<DisplayConfig>,
    pub sidecar: Option<ManifestSidecar>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct DisplayConfig {
    pub duration_seconds: Option<u32>,
    pub transition_in: Option<String>,
    pub transition_out: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct ManifestSidecar {
    #[serde(default)]
    pub wasi_preopens: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ManifestValidationError {
    AbiVersion { found: u32, expected: u32 },
    UnknownSceneSpace(String),
    DurationSecondsOutOfBounds(u32),
    InvalidSidecarPreopen(String),
}

impl std::fmt::Display for ManifestValidationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::AbiVersion { found, expected } => {
                write!(f, "abi_version {found} does not match expected {expected}")
            }
            Self::UnknownSceneSpace(space) => write!(f, "unknown scene_space '{space}'"),
            Self::DurationSecondsOutOfBounds(seconds) => write!(
                f,
                "display duration {seconds}s is out of bounds [{MIN_DISPLAY_DURATION_SECONDS}, {MAX_DISPLAY_DURATION_SECONDS}]s"
            ),
            Self::InvalidSidecarPreopen(spec) => {
                write!(f, "invalid sidecar preopen '{spec}'")
            }
        }
    }
}

impl std::error::Error for ManifestValidationError {}

impl SlideManifest {
    pub fn validate(&self, expected_abi: u32) -> Result<(), ManifestValidationError> {
        if let Some(found) = self.abi_version {
            if found != expected_abi {
                return Err(ManifestValidationError::AbiVersion {
                    found,
                    expected: expected_abi,
                });
            }
        }

        if let Some(space) = self.scene_space.as_deref() {
            if !matches!(space, "screen_2d" | "world_3d") {
                return Err(ManifestValidationError::UnknownSceneSpace(
                    space.to_string(),
                ));
            }
        }

        if let Some(duration) = self
            .display
            .as_ref()
            .and_then(|display| display.duration_seconds)
        {
            if !(MIN_DISPLAY_DURATION_SECONDS..=MAX_DISPLAY_DURATION_SECONDS).contains(&duration) {
                return Err(ManifestValidationError::DurationSecondsOutOfBounds(
                    duration,
                ));
            }
        }

        if let Some(sidecar) = &self.sidecar {
            for preopen in &sidecar.wasi_preopens {
                validate_sidecar_preopen(preopen)?;
            }
        }

        Ok(())
    }
}

fn validate_sidecar_preopen(spec: &str) -> Result<(), ManifestValidationError> {
    let Some((host, guest)) = spec.rsplit_once(':') else {
        return Err(ManifestValidationError::InvalidSidecarPreopen(
            spec.to_string(),
        ));
    };

    if host.is_empty() || guest.is_empty() || !host.starts_with('/') || !guest.starts_with('/') {
        return Err(ManifestValidationError::InvalidSidecarPreopen(
            spec.to_string(),
        ));
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_minimal_manifest() {
        let manifest: SlideManifest =
            serde_json::from_str("{\"name\":\"demo\"}").expect("parse manifest");
        manifest.validate(1).expect("valid manifest");
    }

    #[test]
    fn rejects_unknown_scene_space() {
        let manifest: SlideManifest =
            serde_json::from_str("{\"scene_space\":\"vr_4d\"}").expect("parse manifest");
        assert!(matches!(
            manifest.validate(1),
            Err(ManifestValidationError::UnknownSceneSpace(space)) if space == "vr_4d"
        ));
    }
}
