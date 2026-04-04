use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const MIN_DISPLAY_DURATION_SECONDS: u32 = 1;
pub const MAX_DISPLAY_DURATION_SECONDS: u32 = 300;

/// Browser-visible package manifest.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct SlideManifest {
    pub name: Option<String>,
    pub version: Option<String>,
    pub author: Option<String>,
    pub description: Option<String>,
    pub abi_version: Option<u32>,
    pub scene_space: Option<String>,
    pub display: Option<DisplayConfig>,
    pub params: Option<ManifestParamsSchema>,
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

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct ManifestParamsSchema {
    #[serde(default)]
    pub fields: Vec<ManifestParamField>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ManifestParamField {
    pub key: String,
    #[serde(rename = "type")]
    pub kind: ManifestParamType,
    #[serde(default)]
    pub required: bool,
    pub label: Option<String>,
    pub help: Option<String>,
    #[serde(default)]
    pub default: Option<Value>,
    #[serde(default)]
    pub options: Vec<ManifestParamOption>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ManifestParamOption {
    pub value: Value,
    pub label: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ManifestParamType {
    String,
    Integer,
    Number,
    Boolean,
    Json,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ManifestValidationError {
    AbiVersion { found: u32, expected: u32 },
    UnknownSceneSpace(String),
    DurationSecondsOutOfBounds(u32),
    InvalidSidecarPreopen(String),
    InvalidParamsSchema(String),
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
            Self::InvalidParamsSchema(message) => write!(f, "{message}"),
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

        if let Some(params) = &self.params {
            validate_params_schema(params)?;
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

fn validate_params_schema(schema: &ManifestParamsSchema) -> Result<(), ManifestValidationError> {
    let mut seen_keys = std::collections::BTreeSet::new();

    for field in &schema.fields {
        let key = field.key.trim();
        if key.is_empty() {
            return Err(ManifestValidationError::InvalidParamsSchema(
                "manifest.params.fields[].key must be a non-empty string".to_string(),
            ));
        }

        if !seen_keys.insert(key.to_string()) {
            return Err(ManifestValidationError::InvalidParamsSchema(format!(
                "manifest.params.fields contains duplicate key '{key}'"
            )));
        }

        if let Some(label) = &field.label {
            if label.trim().is_empty() {
                return Err(ManifestValidationError::InvalidParamsSchema(format!(
                    "manifest.params.fields['{key}'].label must not be blank"
                )));
            }
        }

        if let Some(help) = &field.help {
            if help.trim().is_empty() {
                return Err(ManifestValidationError::InvalidParamsSchema(format!(
                    "manifest.params.fields['{key}'].help must not be blank"
                )));
            }
        }

        if let Some(default) = &field.default {
            validate_param_value(
                default,
                field.kind,
                &format!("manifest.params.fields['{key}'].default"),
            )?;
        }

        if matches!(field.kind, ManifestParamType::Json) && !field.options.is_empty() {
            return Err(ManifestValidationError::InvalidParamsSchema(format!(
                "manifest.params.fields['{key}'].options are not supported for json fields"
            )));
        }

        let mut seen_options = std::collections::BTreeSet::new();
        for (index, option) in field.options.iter().enumerate() {
            validate_param_value(
                &option.value,
                field.kind,
                &format!("manifest.params.fields['{key}'].options[{index}].value"),
            )?;

            if let Some(label) = &option.label {
                if label.trim().is_empty() {
                    return Err(ManifestValidationError::InvalidParamsSchema(format!(
                        "manifest.params.fields['{key}'].options[{index}].label must not be blank"
                    )));
                }
            }

            let option_key = serde_json::to_string(&option.value).map_err(|error| {
                ManifestValidationError::InvalidParamsSchema(format!(
                    "manifest.params.fields['{key}'].options[{index}].value could not be serialized: {error}"
                ))
            })?;
            if !seen_options.insert(option_key) {
                return Err(ManifestValidationError::InvalidParamsSchema(format!(
                    "manifest.params.fields['{key}'].options contains duplicate values"
                )));
            }
        }

        if let Some(default) = &field.default {
            if !field.options.is_empty()
                && !field.options.iter().any(|option| option.value == *default)
            {
                return Err(ManifestValidationError::InvalidParamsSchema(format!(
                    "manifest.params.fields['{key}'].default must match one of the declared options"
                )));
            }
        }
    }

    Ok(())
}

fn validate_param_value(
    value: &Value,
    kind: ManifestParamType,
    label: &str,
) -> Result<(), ManifestValidationError> {
    let is_valid = match kind {
        ManifestParamType::String => matches!(value, Value::String(_)),
        ManifestParamType::Integer => value.as_i64().is_some() || value.as_u64().is_some(),
        ManifestParamType::Number => value.as_f64().is_some(),
        ManifestParamType::Boolean => matches!(value, Value::Bool(_)),
        ManifestParamType::Json => true,
    };

    if is_valid {
        Ok(())
    } else {
        Err(ManifestValidationError::InvalidParamsSchema(format!(
            "{label} does not match field type '{kind}'"
        )))
    }
}

impl std::fmt::Display for ManifestParamType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let value = match self {
            Self::String => "string",
            Self::Integer => "integer",
            Self::Number => "number",
            Self::Boolean => "boolean",
            Self::Json => "json",
        };
        write!(f, "{value}")
    }
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

    #[test]
    fn accepts_manifest_param_schema() {
        let manifest: SlideManifest = serde_json::from_str(
            r#"{
                "params": {
                    "fields": [
                        {
                            "key": "mode",
                            "type": "string",
                            "required": true,
                            "label": "Mode",
                            "default": "demo",
                            "options": [
                                { "value": "demo", "label": "Demo" },
                                { "value": "live", "label": "Live" }
                            ]
                        },
                        {
                            "key": "refresh_seconds",
                            "type": "integer",
                            "help": "Refresh cadence",
                            "default": 15
                        },
                        {
                            "key": "debug",
                            "type": "boolean",
                            "default": false
                        },
                        {
                            "key": "overrides",
                            "type": "json",
                            "default": { "theme": "night" }
                        }
                    ]
                }
            }"#,
        )
        .expect("parse manifest");

        manifest.validate(1).expect("valid manifest");
    }

    #[test]
    fn rejects_duplicate_param_keys() {
        let manifest: SlideManifest = serde_json::from_str(
            r#"{
                "params": {
                    "fields": [
                        { "key": "mode", "type": "string" },
                        { "key": "mode", "type": "string" }
                    ]
                }
            }"#,
        )
        .expect("parse manifest");

        assert!(matches!(
            manifest.validate(1),
            Err(ManifestValidationError::InvalidParamsSchema(message))
                if message.contains("duplicate key 'mode'")
        ));
    }

    #[test]
    fn rejects_mismatched_param_defaults() {
        let manifest: SlideManifest = serde_json::from_str(
            r#"{
                "params": {
                    "fields": [
                        { "key": "refresh_seconds", "type": "integer", "default": "15" }
                    ]
                }
            }"#,
        )
        .expect("parse manifest");

        assert!(matches!(
            manifest.validate(1),
            Err(ManifestValidationError::InvalidParamsSchema(message))
                if message.contains("does not match field type 'integer'")
        ));
    }

    #[test]
    fn rejects_json_param_options() {
        let manifest: SlideManifest = serde_json::from_str(
            r#"{
                "params": {
                    "fields": [
                        {
                            "key": "payload",
                            "type": "json",
                            "options": [{ "value": { "mode": "demo" } }]
                        }
                    ]
                }
            }"#,
        )
        .expect("parse manifest");

        assert!(matches!(
            manifest.validate(1),
            Err(ManifestValidationError::InvalidParamsSchema(message))
                if message.contains("not supported for json fields")
        ));
    }
}
