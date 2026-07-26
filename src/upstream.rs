use serde_json::json;
use worker::{Env, Headers, Method, RequestInit, Response, Result, wasm_bindgen::JsValue};

use crate::model::{Account, AccountEnvelope};

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
    let headers = console_headers(env)?;
    headers.set("X-Account-ID", account_id)?;
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
