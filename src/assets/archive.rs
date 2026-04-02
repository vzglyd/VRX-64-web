/// Minimal archive guard used before JS-side extraction.
///
/// `.vzglyd` packages are zip archives and should start with a PK signature.
pub fn looks_like_zip_archive(bytes: &[u8]) -> bool {
    let Some(signature) = bytes.get(0..4) else {
        return false;
    };
    signature == [0x50, 0x4b, 0x03, 0x04] || signature == [0x50, 0x4b, 0x05, 0x06]
}

#[cfg(test)]
mod tests {
    use super::looks_like_zip_archive;

    #[test]
    fn accepts_standard_zip_signature() {
        assert!(looks_like_zip_archive(&[0x50, 0x4b, 0x03, 0x04, 0x00]));
    }

    #[test]
    fn rejects_non_zip_signature() {
        assert!(!looks_like_zip_archive(&[0xde, 0xad, 0xbe, 0xef]));
    }
}
