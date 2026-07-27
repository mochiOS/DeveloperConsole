use base64::{Engine, engine::general_purpose::STANDARD};
use ed25519_dalek::SigningKey;
use mochios_developer_ca_auth_token::{Claims, issue};
use serde_json::json;
use worker::{Date, Env, Headers, Method, RequestInit, Response, Result, wasm_bindgen::JsValue};

use crate::model::{Account, AccountEnvelope};

const MAX_UPSTREAM_RESPONSE_BYTES: usize = 1024 * 1024;

fn developer_ca_token(env: &Env, account_id: &str, admin: bool) -> Result<String> {
    let bytes = STANDARD
        .decode(env.secret("DEVELOPER_CA_TOKEN_SIGNING_KEY")?.to_string())
        .map_err(|_| worker::Error::RustError("invalid DeveloperCA token signing key".into()))?;
    let seed: [u8; 32] = bytes
        .try_into()
        .map_err(|_| worker::Error::RustError("invalid DeveloperCA token signing key".into()))?;
    let now = Date::now().as_millis() / 1000;
    let claims = Claims {
        iss: "console.mochios.org".into(),
        sub: account_id.into(),
        aud: if admin {
            "developer-ca-admin".into()
        } else {
            "developer-ca".into()
        },
        iat: now,
        exp: now + 60,
        jti: crate::security::random_token()
            .map_err(|_| worker::Error::RustError("secure random generation failed".into()))?,
        role: if admin {
            "developer_ca_reviewer".into()
        } else {
            "delegated_account".into()
        },
        act: Some("mochios-console".into()),
    };
    issue(&claims, &SigningKey::from_bytes(&seed))
        .map_err(|error| worker::Error::RustError(error.to_string()))
}

fn developer_ca_headers(env: &Env, account_id: &str, admin: bool) -> Result<Headers> {
    let headers = Headers::new();
    headers.set(
        "Authorization",
        &format!("Bearer {}", developer_ca_token(env, account_id, admin)?),
    )?;
    headers.set("Accept", "application/json")?;
    Ok(headers)
}

fn console_headers(env: &Env) -> Result<Headers> {
    let headers = Headers::new();
    headers.set(
        "X-Console-Service-Token",
        &env.secret("CONSOLE_SERVICE_TOKEN")?.to_string(),
    )?;
    headers.set("Accept", "application/json")?;
    Ok(headers)
}

pub async fn exchange_code(env: &Env, code: &str) -> Result<Option<Account>> {
    let headers = console_headers(env)?;
    headers.set("Content-Type", "application/json")?;
    let mut init = RequestInit::new();
    init.with_method(Method::Post)
        .with_headers(headers)
        .with_body(Some(JsValue::from_str(&json!({"code": code}).to_string())));
    let mut response = env
        .service("ACCOUNTS")?
        .fetch(
            "https://accounts.internal/v1/internal/console/exchange",
            Some(init),
        )
        .await?;
    if response.status_code() != 200 {
        return Ok(None);
    }
    let envelope: AccountEnvelope = response.json().await?;
    Ok((envelope.account.status == "active").then_some(envelope.account))
}

pub async fn account(env: &Env, account_id: &str) -> Result<Option<Account>> {
    let mut init = RequestInit::new();
    init.with_headers(console_headers(env)?);
    let mut response = env
        .service("ACCOUNTS")?
        .fetch(
            format!("https://accounts.internal/v1/internal/accounts/{account_id}"),
            Some(init),
        )
        .await?;
    if response.status_code() != 200 {
        return Ok(None);
    }
    let envelope: AccountEnvelope = response.json().await?;
    Ok((envelope.account.status == "active").then_some(envelope.account))
}

pub async fn developer_ca(
    env: &Env,
    account_id: &str,
    method: Method,
    path: &str,
    body: Option<Vec<u8>>,
) -> Result<Response> {
    let headers = developer_ca_headers(env, account_id, false)?;
    if body.is_some() {
        headers.set("Content-Type", "application/json")?;
    }
    let mut init = RequestInit::new();
    init.with_method(method).with_headers(headers);
    if let Some(body) = body {
        init.with_body(Some(js_sys::Uint8Array::from(body.as_slice()).into()));
    }
    let mut upstream = env
        .service("DEVELOPER_CA")?
        .fetch(format!("https://developer-ca.internal{path}"), Some(init))
        .await?;
    let status = upstream.status_code();
    let content_type = upstream
        .headers()
        .get("Content-Type")?
        .unwrap_or_else(|| "application/json; charset=utf-8".into());
    let bytes = upstream.bytes().await?;
    let mut response = Response::from_bytes(bytes)?.with_status(status);
    response.headers_mut().set("Content-Type", &content_type)?;
    response.headers_mut().set("Cache-Control", "no-store")?;
    Ok(response)
}

pub async fn developer_ca_admin(
    env: &Env,
    account_id: &str,
    method: Method,
    path: &str,
    body: Option<Vec<u8>>,
) -> Result<Response> {
    let headers = developer_ca_headers(env, account_id, true)?;
    if body.is_some() {
        headers.set("Content-Type", "application/json")?;
    }
    let mut init = RequestInit::new();
    init.with_method(method).with_headers(headers);
    if let Some(body) = body {
        init.with_body(Some(js_sys::Uint8Array::from(body.as_slice()).into()));
    }
    let mut upstream = env
        .service("DEVELOPER_CA")?
        .fetch(format!("https://developer-ca.internal{path}"), Some(init))
        .await?;
    if upstream
        .headers()
        .get("Content-Length")?
        .and_then(|value| value.parse::<usize>().ok())
        .is_some_and(|length| length > MAX_UPSTREAM_RESPONSE_BYTES)
    {
        return Err(worker::Error::RustError(
            "DeveloperCA response exceeds the Console limit".into(),
        ));
    }
    let status = upstream.status_code();
    let content_type = upstream
        .headers()
        .get("Content-Type")?
        .unwrap_or_else(|| "application/json; charset=utf-8".into());
    let bytes = upstream.bytes().await?;
    if bytes.len() > MAX_UPSTREAM_RESPONSE_BYTES {
        return Err(worker::Error::RustError(
            "DeveloperCA response exceeds the Console limit".into(),
        ));
    }
    let mut response = Response::from_bytes(bytes)?.with_status(status);
    response.headers_mut().set("Content-Type", &content_type)?;
    response.headers_mut().set("Cache-Control", "no-store")?;
    Ok(response)
}

pub async fn app_store(
    env: &Env,
    account_id: &str,
    method: Method,
    path: &str,
    body: Option<Vec<u8>>,
) -> Result<Response> {
    let headers = Headers::new();
    headers.set(
        "X-Admin-Token",
        &env.secret("APPSTORE_ADMIN_TOKEN")?.to_string(),
    )?;
    headers.set("X-Admin-Account-ID", account_id)?;
    headers.set("Accept", "application/json")?;
    if body.is_some() {
        headers.set("Content-Type", "application/json")?;
    }
    let mut init = RequestInit::new();
    init.with_method(method).with_headers(headers);
    if let Some(body) = body {
        init.with_body(Some(js_sys::Uint8Array::from(body.as_slice()).into()));
    }
    let mut upstream = env
        .service("APP_STORE")?
        .fetch(format!("https://app-store.internal{path}"), Some(init))
        .await?;
    if upstream
        .headers()
        .get("Content-Length")?
        .and_then(|value| value.parse::<usize>().ok())
        .is_some_and(|length| length > MAX_UPSTREAM_RESPONSE_BYTES)
    {
        return Err(worker::Error::RustError(
            "App Store response exceeds the Console limit".into(),
        ));
    }
    let status = upstream.status_code();
    let content_type = upstream
        .headers()
        .get("Content-Type")?
        .unwrap_or_else(|| "application/json; charset=utf-8".into());
    let bytes = upstream.bytes().await?;
    if bytes.len() > MAX_UPSTREAM_RESPONSE_BYTES {
        return Err(worker::Error::RustError(
            "App Store response exceeds the Console limit".into(),
        ));
    }
    let mut response = Response::from_bytes(bytes)?.with_status(status);
    response.headers_mut().set("Content-Type", &content_type)?;
    response.headers_mut().set("Cache-Control", "no-store")?;
    Ok(response)
}
