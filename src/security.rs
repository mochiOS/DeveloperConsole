use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

pub const AUTH_STATE_COOKIE: &str = "__Host-mochios_console_auth_state";
pub const SESSION_COOKIE: &str = "__Host-mochios_console_session";

pub fn random_token() -> Result<String, getrandom::Error> {
    let mut bytes = [0_u8; 32];
    getrandom::fill(&mut bytes)?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

pub fn token_hash(token: &str) -> String {
    Sha256::digest(token.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

pub fn constant_time_eq(expected: &str, provided: &str) -> bool {
    expected.len() == provided.len() && bool::from(expected.as_bytes().ct_eq(provided.as_bytes()))
}

pub fn secure_cookie(name: &str, value: &str, max_age: u64) -> String {
    format!("{name}={value}; Path=/; Max-Age={max_age}; Secure; HttpOnly; SameSite=Lax")
}

pub fn expired_cookie(name: &str) -> String {
    secure_cookie(name, "", 0)
}

pub fn parse_cookie(header: &str, name: &str) -> Option<String> {
    header.split(';').find_map(|part| {
        let (key, value) = part.trim().split_once('=')?;
        (key == name).then(|| value.to_owned())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_cookies_are_secure_and_http_only() {
        let cookie = secure_cookie(SESSION_COOKIE, "opaque", 60);
        assert!(cookie.starts_with("__Host-"));
        assert!(cookie.contains("Secure"));
        assert!(cookie.contains("HttpOnly"));
        assert!(cookie.contains("SameSite=Lax"));
        assert!(!cookie.contains("Domain="));
    }
}
