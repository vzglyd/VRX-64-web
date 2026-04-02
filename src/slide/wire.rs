/// ABI v1 slide wire version byte.
pub const WIRE_VERSION: u8 = 1;

/// Validates that a raw wire blob starts with the expected version byte.
pub fn validate_wire_blob(bytes: &[u8]) -> Result<(), String> {
    let (version, _payload) = bytes
        .split_first()
        .ok_or_else(|| "missing version byte in slide wire format".to_string())?;

    if *version != WIRE_VERSION {
        return Err(format!(
            "unsupported slide wire version {version}; expected {WIRE_VERSION}"
        ));
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_v1_wire_blob() {
        validate_wire_blob(&[WIRE_VERSION, 0xaa, 0xbb]).expect("v1 blob");
    }

    #[test]
    fn rejects_empty_blob() {
        assert!(validate_wire_blob(&[]).is_err());
    }
}
