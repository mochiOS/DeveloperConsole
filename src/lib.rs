mod model;
mod security;
mod store;
mod upstream;

use std::net::IpAddr;

use model::Account;
use security::{
    AUTH_STATE_COOKIE, SESSION_COOKIE, constant_time_eq, expired_cookie, parse_cookie,
    random_token, secure_cookie,
};
use serde::Deserialize;
use serde::Serialize;
use serde_json::json;
use worker::*;

const MAX_JSON_BODY_BYTES: usize = 64 * 1024;
const STATUS_ORIGIN: &str = "https://status.mochios.org";

fn now() -> i64 {
    (Date::now().as_millis() / 1000) as i64
}

fn json_response<T: Serialize>(value: &T, status: u16) -> Result<Response> {
    let mut response = Response::from_json(value)?.with_status(status);
    response.headers_mut().set("Cache-Control", "no-store")?;
    Ok(response)
}

fn with_health_cors(mut response: Response) -> Result<Response> {
    let headers = response.headers_mut();
    headers.set("Access-Control-Allow-Origin", STATUS_ORIGIN)?;
    headers.set("Access-Control-Allow-Methods", "GET, OPTIONS")?;
    headers.set("Access-Control-Allow-Headers", "Content-Type")?;
    headers.set("Access-Control-Max-Age", "3600")?;
    headers.set("Cache-Control", "no-store")?;
    headers.set("Vary", "Origin")?;
    Ok(response)
}

fn health_response() -> Result<Response> {
    with_health_cors(Response::from_json(
        &json!({"status":"ok","service":"console"}),
    )?)
}

fn health_preflight() -> Result<Response> {
    with_health_cors(Response::empty()?.with_status(204))
}

fn error(code: &str, message: &str, status: u16) -> Result<Response> {
    json_response(
        &json!({"error": {"code": code, "message": message}}),
        status,
    )
}

fn redirect(location: &Url) -> Result<Response> {
    let mut response = Response::empty()?.with_status(302);
    response.headers_mut().set("Location", location.as_str())?;
    response.headers_mut().set("Cache-Control", "no-store")?;
    Ok(response)
}

fn cookie_header(req: &Request) -> Result<String> {
    Ok(req.headers().get("Cookie")?.unwrap_or_default())
}

fn session_token(req: &Request) -> Result<Option<String>> {
    Ok(parse_cookie(&cookie_header(req)?, SESSION_COOKIE))
}

async fn current_account(req: &Request, env: &Env) -> Result<Option<Account>> {
    let Some(token) = session_token(req)? else {
        return Ok(None);
    };
    let Some(session) = store::authenticate_session(&env.d1("DB")?, &token, now()).await? else {
        return Ok(None);
    };
    upstream::account(env, &session.account_id).await
}

async fn auth_start(_req: Request, ctx: RouteContext<()>) -> Result<Response> {
    let state =
        random_token().map_err(|_| Error::RustError("secure random generation failed".into()))?;
    let accounts = ctx.env.var("ACCOUNTS_PUBLIC_URL")?.to_string();
    let mut location = Url::parse(&format!(
        "{}/v1/console/authorize",
        accounts.trim_end_matches('/')
    ))?;
    location.query_pairs_mut().append_pair("state", &state);
    let mut response = redirect(&location)?;
    response
        .headers_mut()
        .append("Set-Cookie", &secure_cookie(AUTH_STATE_COOKIE, &state, 600))?;
    Ok(response)
}

async fn auth_callback(req: Request, ctx: RouteContext<()>) -> Result<Response> {
    let params: std::collections::HashMap<_, _> = req.url()?.query_pairs().into_owned().collect();
    let code = params.get("code").cloned().unwrap_or_default();
    let state = params.get("state").cloned().unwrap_or_default();
    let expected = parse_cookie(&cookie_header(&req)?, AUTH_STATE_COOKIE).unwrap_or_default();
    if code.len() != 43
        || state.is_empty()
        || expected.is_empty()
        || !constant_time_eq(&expected, &state)
    {
        return error(
            "AUTHORIZATION_RESPONSE_INVALID",
            "ログイン応答が無効です。最初からやり直してください。",
            400,
        );
    }
    let Some(account) = upstream::exchange_code(&ctx.env, &code).await? else {
        return error(
            "AUTHORIZATION_CODE_INVALID",
            "認可コードが無効または期限切れです。",
            400,
        );
    };
    let ttl = ctx
        .env
        .var("SESSION_TTL_SECONDS")?
        .to_string()
        .parse::<i64>()
        .unwrap_or(2_592_000);
    let session = store::issue_session(&ctx.env.d1("DB")?, &account.id, now(), ttl).await?;
    let base = ctx.env.var("CONSOLE_BASE_URL")?.to_string();
    let mut response = redirect(&Url::parse(&format!("{}/", base.trim_end_matches('/')))?)?;
    response
        .headers_mut()
        .append("Set-Cookie", &expired_cookie(AUTH_STATE_COOKIE))?;
    response.headers_mut().append(
        "Set-Cookie",
        &secure_cookie(SESSION_COOKIE, &session.token, ttl.max(60) as u64),
    )?;
    Ok(response)
}

async fn me(req: Request, ctx: RouteContext<()>) -> Result<Response> {
    match current_account(&req, &ctx.env).await? {
        Some(account) => {
            let db = ctx.env.d1("DB")?;
            let app_store_reviewer = store::is_app_store_reviewer(&db, &account.id).await?;
            let developer_ca_reviewer = store::is_developer_ca_reviewer(&db, &account.id).await?;
            json_response(
                &json!({
                    "account": account,
                    "app_store_reviewer": app_store_reviewer,
                    "developer_ca_reviewer": developer_ca_reviewer,
                }),
                200,
            )
        }
        None => error("UNAUTHENTICATED", "ログインが必要です。", 401),
    }
}

async fn logout(req: Request, ctx: RouteContext<()>) -> Result<Response> {
    if let Some(token) = session_token(&req)? {
        store::revoke_session(&ctx.env.d1("DB")?, &token, now()).await?;
    }
    let mut response = Response::empty()?.with_status(204);
    response
        .headers_mut()
        .append("Set-Cookie", &expired_cookie(SESSION_COOKIE))?;
    response.headers_mut().set("Cache-Control", "no-store")?;
    Ok(response)
}

fn mutation_origin_allowed(req: &Request, env: &Env) -> Result<bool> {
    if matches!(req.method(), Method::Get | Method::Head | Method::Options) {
        return Ok(true);
    }
    let expected = env.var("CONSOLE_BASE_URL")?.to_string();
    let origin = req.headers().get("Origin")?.unwrap_or_default();
    Ok(origin == expected.trim_end_matches('/'))
}

struct RequestAuditContext {
    ip_address: Option<String>,
    user_agent: Option<String>,
    cf_ray: Option<String>,
}

fn request_audit_context(req: &Request) -> Result<RequestAuditContext> {
    let headers = req.headers();
    let ip_address = ["CF-Connecting-IPv6", "CF-Connecting-IP"]
        .into_iter()
        .find_map(|name| {
            headers
                .get(name)
                .ok()
                .flatten()
                .and_then(|value| value.parse::<IpAddr>().ok())
                .map(|value| value.to_string())
        });
    let user_agent = headers.get("User-Agent")?.and_then(|value| {
        let value = value.trim().chars().take(512).collect::<String>();
        (!value.is_empty()).then_some(value)
    });
    let cf_ray = headers.get("CF-Ray")?.and_then(|value| {
        let value = value.trim();
        (!value.is_empty()
            && value.len() <= 128
            && value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-'))
        .then(|| value.to_owned())
    });
    Ok(RequestAuditContext {
        ip_address,
        user_agent,
        cf_ray,
    })
}

async fn proxy_route(mut req: Request, ctx: RouteContext<()>) -> Result<Response> {
    let Some(account) = current_account(&req, &ctx.env).await? else {
        return error("UNAUTHENTICATED", "ログインが必要です。", 401);
    };
    if !mutation_origin_allowed(&req, &ctx.env)? {
        return error("ORIGIN_INVALID", "リクエスト元を確認できません。", 403);
    }
    let path = req.path();
    let method = req.method();
    let body = if matches!(method, Method::Post | Method::Patch | Method::Put) {
        if req
            .headers()
            .get("Content-Length")?
            .and_then(|value| value.parse::<usize>().ok())
            .is_some_and(|length| length > MAX_JSON_BODY_BYTES)
        {
            return error("REQUEST_TOO_LARGE", "リクエストが大きすぎます。", 413);
        }
        let bytes = req.bytes().await?;
        if bytes.len() > MAX_JSON_BODY_BYTES {
            return error("REQUEST_TOO_LARGE", "リクエストが大きすぎます。", 413);
        }
        Some(bytes)
    } else {
        None
    };
    upstream::developer_ca(&ctx.env, &account.id, method, &path, body, None).await
}

fn valid_release_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 80
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn valid_developer_id(value: &str) -> bool {
    value.len() == 32 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

async fn app_store_developer_proxy(mut req: Request, ctx: RouteContext<()>) -> Result<Response> {
    let Some(account) = current_account(&req, &ctx.env).await? else {
        return error("UNAUTHENTICATED", "ログインが必要です。", 401);
    };
    if !mutation_origin_allowed(&req, &ctx.env)? {
        return error("ORIGIN_INVALID", "リクエスト元を確認できません。", 403);
    }
    let developer_id = ctx.param("developer_id").map(String::as_str).unwrap_or("");
    if !valid_developer_id(developer_id) {
        return error("DEVELOPER_ID_INVALID", "Developer IDが無効です。", 422);
    }
    let bundle_id = ctx.param("bundle_id").map(String::as_str);
    if bundle_id.is_some_and(|value| !valid_package_id(value)) {
        return error("PACKAGE_ID_INVALID", "Package IDが無効です。", 422);
    }
    let path = if req.path().ends_with("/bundle-ids") {
        "/v1/bundle-ids".to_owned()
    } else if let Some(bundle_id) = bundle_id {
        if req.path().ends_with("/releases") {
            format!("/v1/developer/apps/{bundle_id}/releases")
        } else {
            format!("/v1/developer/apps/{bundle_id}")
        }
    } else {
        "/v1/developer/apps".to_owned()
    };
    let method = req.method();
    let body = if matches!(method, Method::Post | Method::Patch | Method::Put) {
        if req
            .headers()
            .get("Content-Length")?
            .and_then(|value| value.parse::<usize>().ok())
            .is_some_and(|length| length > MAX_JSON_BODY_BYTES)
        {
            return error("REQUEST_TOO_LARGE", "リクエストが大きすぎます。", 413);
        }
        let bytes = req.bytes().await?;
        if bytes.len() > MAX_JSON_BODY_BYTES {
            return error("REQUEST_TOO_LARGE", "リクエストが大きすぎます。", 413);
        }
        Some(bytes)
    } else {
        None
    };
    upstream::app_store_developer(&ctx.env, &account.id, developer_id, method, &path, body).await
}

async fn reviewer_account(
    req: &Request,
    env: &Env,
) -> Result<std::result::Result<Account, Response>> {
    let Some(account) = current_account(req, env).await? else {
        return Ok(Err(error("UNAUTHENTICATED", "ログインが必要です。", 401)?));
    };
    if !store::is_app_store_reviewer(&env.d1("DB")?, &account.id).await? {
        return Ok(Err(error(
            "REVIEWER_REQUIRED",
            "App Store審査担当者だけが利用できます。",
            403,
        )?));
    }
    Ok(Ok(account))
}

async fn review_list(req: Request, ctx: RouteContext<()>) -> Result<Response> {
    let account = match reviewer_account(&req, &ctx.env).await? {
        Ok(account) => account,
        Err(response) => return Ok(response),
    };
    let status = req
        .url()?
        .query_pairs()
        .find(|(key, _)| key == "status")
        .map(|(_, value)| value.into_owned())
        .unwrap_or_else(|| "queue".into());
    if !matches!(status.as_str(), "queue" | "approved" | "rejected") {
        return error("STATUS_INVALID", "状態が無効です。", 422);
    }
    upstream::app_store(
        &ctx.env,
        &account.id,
        Method::Get,
        &format!("/v1/admin/releases?status={status}"),
        None,
    )
    .await
}

async fn management_audit_logs(req: Request, ctx: RouteContext<()>) -> Result<Response> {
    let Some(account) = current_account(&req, &ctx.env).await? else {
        return error("UNAUTHENTICATED", "ログインが必要です。", 401);
    };
    let db = ctx.env.d1("DB")?;
    let app_store_access = store::is_app_store_reviewer(&db, &account.id).await?;
    let developer_ca_access = store::is_developer_ca_reviewer(&db, &account.id).await?;
    if !app_store_access && !developer_ca_access {
        return error("ADMIN_REQUIRED", "管理者だけが利用できます。", 403);
    }
    let logs = store::review_audit_logs(&db, app_store_access, developer_ca_access).await?;
    json_response(&json!({"audit_logs": logs}), 200)
}

async fn developer_reviewer_account(
    req: &Request,
    env: &Env,
) -> Result<std::result::Result<Account, Response>> {
    let Some(account) = current_account(req, env).await? else {
        return Ok(Err(error("UNAUTHENTICATED", "ログインが必要です。", 401)?));
    };
    if !store::is_developer_ca_reviewer(&env.d1("DB")?, &account.id).await? {
        return Ok(Err(error(
            "REVIEWER_REQUIRED",
            "Developer審査担当者だけが利用できます。",
            403,
        )?));
    }
    Ok(Ok(account))
}

fn valid_review_resource_id(value: &str) -> bool {
    (value.len() == 32 && value.bytes().all(|byte| byte.is_ascii_hexdigit()))
        || (value.len() == 36
            && value
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() || byte == b'-'))
}

fn valid_package_id(value: &str) -> bool {
    mochios_certificate::is_valid_package_id(value)
}

fn valid_revocation_reason_code(value: &str) -> bool {
    matches!(
        value,
        "key_compromise"
            | "developer_suspended"
            | "certificate_replaced"
            | "scope_violation"
            | "administrative"
            | "unspecified"
    )
}

async fn developer_review_queue(req: Request, ctx: RouteContext<()>) -> Result<Response> {
    let account = match developer_reviewer_account(&req, &ctx.env).await? {
        Ok(account) => account,
        Err(response) => return Ok(response),
    };
    upstream::developer_ca_admin(
        &ctx.env,
        &account.id,
        Method::Get,
        "/v1/admin/review-queue",
        None,
    )
    .await
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DeveloperReviewActionInput {
    reason: Option<String>,
    reason_code: Option<String>,
}

async fn developer_review_action(mut req: Request, ctx: RouteContext<()>) -> Result<Response> {
    let account = match developer_reviewer_account(&req, &ctx.env).await? {
        Ok(account) => account,
        Err(response) => return Ok(response),
    };
    if !mutation_origin_allowed(&req, &ctx.env)? {
        return error("ORIGIN_INVALID", "リクエスト元を確認できません。", 403);
    }
    let audit_context = request_audit_context(&req)?;
    let kind = ctx.param("kind").map(String::as_str).unwrap_or("");
    let resource_id = ctx.param("resource_id").map(String::as_str).unwrap_or("");
    let action = ctx.param("action").map(String::as_str).unwrap_or("");
    if !valid_review_resource_id(resource_id) {
        return error("RESOURCE_ID_INVALID", "審査対象IDが無効です。", 422);
    }
    let requires_reason = matches!(action, "reject" | "revoke" | "suspend");
    let (reason, reason_code) = if requires_reason {
        let bytes = req.bytes().await?;
        if bytes.len() > MAX_JSON_BODY_BYTES {
            return error("REQUEST_TOO_LARGE", "リクエストが大きすぎます。", 413);
        }
        let input: DeveloperReviewActionInput = match serde_json::from_slice(&bytes) {
            Ok(input) => input,
            Err(_) => return error("JSON_INVALID", "JSONリクエストが無効です。", 400),
        };
        let reason = input.reason.unwrap_or_default().trim().to_owned();
        if reason.is_empty() || reason.len() > 2000 {
            return error(
                "VALIDATION_ERROR",
                "理由は1〜2000文字で入力してください。",
                422,
            );
        }
        let reason_code = input
            .reason_code
            .filter(|code| valid_revocation_reason_code(code));
        if action == "revoke" && reason_code.is_none() {
            return error(
                "REVOCATION_REASON_CODE_INVALID",
                "失効理由コードを選択してください。",
                422,
            );
        }
        (Some(reason), reason_code)
    } else {
        (None, None)
    };
    let (path, body) = match (kind, action) {
        ("developers", "suspend") => (
            format!("/v1/admin/developers/{resource_id}/suspend"),
            Some(serde_json::to_vec(&json!({"reason": reason}))?),
        ),
        ("developers", "restore") => (format!("/v1/admin/developers/{resource_id}/restore"), None),
        ("creation-requests", "approve") => (
            format!("/v1/admin/developer-creation-requests/{resource_id}/approve"),
            Some(b"{}".to_vec()),
        ),
        ("creation-requests", "reject") => (
            format!("/v1/admin/developer-creation-requests/{resource_id}/reject"),
            Some(serde_json::to_vec(&json!({"rejection_reason": reason}))?),
        ),
        ("certificates", "suspend") => (
            format!("/v1/admin/certificates/{resource_id}/suspend"),
            Some(serde_json::to_vec(&json!({"reason": reason}))?),
        ),
        ("certificates", "restore") => (
            format!("/v1/admin/certificates/{resource_id}/restore"),
            None,
        ),
        ("certificates", "revoke") => (
            format!("/v1/admin/certificates/{resource_id}/revoke"),
            Some(serde_json::to_vec(
                &json!({"reason": reason, "reason_code": reason_code}),
            )?),
        ),
        _ => return error("REVIEW_ACTION_INVALID", "審査操作が無効です。", 404),
    };
    let response =
        upstream::developer_ca_admin(&ctx.env, &account.id, Method::Post, &path, body).await?;
    if response.status_code() < 400 {
        store::record_review_action(
            &ctx.env.d1("DB")?,
            &account.id,
            &format!("developer_ca.{kind}.{action}"),
            resource_id,
            audit_context.ip_address.as_deref(),
            audit_context.user_agent.as_deref(),
            audit_context.cf_ray.as_deref(),
            now(),
        )
        .await?;
    }
    Ok(response)
}

async fn package_list(req: Request, ctx: RouteContext<()>) -> Result<Response> {
    let account = match reviewer_account(&req, &ctx.env).await? {
        Ok(account) => account,
        Err(response) => return Ok(response),
    };
    let status = req
        .url()?
        .query_pairs()
        .find(|(key, _)| key == "status")
        .map(|(_, value)| value.into_owned())
        .unwrap_or_else(|| "active".into());
    if !matches!(status.as_str(), "active" | "blocked") {
        return error("STATUS_INVALID", "状態が無効です。", 422);
    }
    upstream::app_store(
        &ctx.env,
        &account.id,
        Method::Get,
        &format!("/v1/admin/packages?status={status}"),
        None,
    )
    .await
}

async fn package_action(mut req: Request, ctx: RouteContext<()>) -> Result<Response> {
    let account = match reviewer_account(&req, &ctx.env).await? {
        Ok(account) => account,
        Err(response) => return Ok(response),
    };
    if !mutation_origin_allowed(&req, &ctx.env)? {
        return error("ORIGIN_INVALID", "リクエスト元を確認できません。", 403);
    }
    let audit_context = request_audit_context(&req)?;
    let bundle_id = ctx.param("bundle_id").map(String::as_str).unwrap_or("");
    let action = ctx.param("action").map(String::as_str).unwrap_or("");
    if !valid_package_id(bundle_id) || !matches!(action, "suspend" | "restore") {
        return error("PACKAGE_ACTION_INVALID", "パッケージ操作が無効です。", 422);
    }
    let body = if action == "suspend" {
        let bytes = req.bytes().await?;
        if bytes.len() > MAX_JSON_BODY_BYTES {
            return error("REQUEST_TOO_LARGE", "リクエストが大きすぎます。", 413);
        }
        let input: DeveloperReviewActionInput = match serde_json::from_slice(&bytes) {
            Ok(input) => input,
            Err(_) => return error("JSON_INVALID", "JSONリクエストが無効です。", 400),
        };
        let reason = input.reason.unwrap_or_default().trim().to_owned();
        if reason.is_empty() || reason.len() > 2000 {
            return error(
                "VALIDATION_ERROR",
                "理由は1〜2000文字で入力してください。",
                422,
            );
        }
        Some(serde_json::to_vec(&json!({"reason":reason}))?)
    } else {
        None
    };
    let response = upstream::app_store(
        &ctx.env,
        &account.id,
        Method::Post,
        &format!("/v1/admin/packages/{bundle_id}/{action}"),
        body,
    )
    .await?;
    if response.status_code() < 400 {
        store::record_review_action(
            &ctx.env.d1("DB")?,
            &account.id,
            &format!("app_store.package.{action}"),
            bundle_id,
            audit_context.ip_address.as_deref(),
            audit_context.user_agent.as_deref(),
            audit_context.cf_ray.as_deref(),
            now(),
        )
        .await?;
    }
    Ok(response)
}

async fn review_detail(req: Request, ctx: RouteContext<()>) -> Result<Response> {
    let account = match reviewer_account(&req, &ctx.env).await? {
        Ok(account) => account,
        Err(response) => return Ok(response),
    };
    let release_id = ctx.param("release_id").map(String::as_str).unwrap_or("");
    if !valid_release_id(release_id) {
        return error("RELEASE_ID_INVALID", "Release IDが無効です。", 422);
    }
    upstream::app_store(
        &ctx.env,
        &account.id,
        Method::Get,
        &format!("/v1/admin/releases/{release_id}"),
        None,
    )
    .await
}

async fn approve_review(req: Request, ctx: RouteContext<()>) -> Result<Response> {
    let account = match reviewer_account(&req, &ctx.env).await? {
        Ok(account) => account,
        Err(response) => return Ok(response),
    };
    if !mutation_origin_allowed(&req, &ctx.env)? {
        return error("ORIGIN_INVALID", "リクエスト元を確認できません。", 403);
    }
    let audit_context = request_audit_context(&req)?;
    let release_id = ctx.param("release_id").map(String::as_str).unwrap_or("");
    if !valid_release_id(release_id) {
        return error("RELEASE_ID_INVALID", "Release IDが無効です。", 422);
    }
    let response = upstream::app_store(
        &ctx.env,
        &account.id,
        Method::Post,
        &format!("/v1/admin/releases/{release_id}/approve"),
        None,
    )
    .await?;
    if response.status_code() < 400 {
        store::record_review_action(
            &ctx.env.d1("DB")?,
            &account.id,
            "app_store.release.approved",
            release_id,
            audit_context.ip_address.as_deref(),
            audit_context.user_agent.as_deref(),
            audit_context.cf_ray.as_deref(),
            now(),
        )
        .await?;
    }
    Ok(response)
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct RejectReviewInput {
    reason_code: String,
    #[serde(default)]
    note: String,
}

async fn reject_review(mut req: Request, ctx: RouteContext<()>) -> Result<Response> {
    let account = match reviewer_account(&req, &ctx.env).await? {
        Ok(account) => account,
        Err(response) => return Ok(response),
    };
    if !mutation_origin_allowed(&req, &ctx.env)? {
        return error("ORIGIN_INVALID", "リクエスト元を確認できません。", 403);
    }
    let audit_context = request_audit_context(&req)?;
    let release_id = ctx.param("release_id").map(String::as_str).unwrap_or("");
    if !valid_release_id(release_id) {
        return error("RELEASE_ID_INVALID", "Release IDが無効です。", 422);
    }
    if req
        .headers()
        .get("Content-Length")?
        .and_then(|value| value.parse::<usize>().ok())
        .is_some_and(|length| length > MAX_JSON_BODY_BYTES)
    {
        return error("REQUEST_TOO_LARGE", "リクエストが大きすぎます。", 413);
    }
    let bytes = req.bytes().await?;
    if bytes.len() > MAX_JSON_BODY_BYTES {
        return error("REQUEST_TOO_LARGE", "リクエストが大きすぎます。", 413);
    }
    let input: RejectReviewInput = match serde_json::from_slice(&bytes) {
        Ok(input) => input,
        Err(_) => return error("JSON_INVALID", "JSONリクエストが無効です。", 400),
    };
    let note = input.note.trim();
    if !matches!(
        input.reason_code.as_str(),
        "metadata_incorrect"
            | "misleading_description"
            | "malicious_behavior"
            | "policy_violation"
            | "duplicate_application"
            | "broken_application"
            | "other"
    ) || note.chars().count() > 2000
    {
        return error(
            "VALIDATION_ERROR",
            "却下理由を選択し、補足は2000文字以内で入力してください。",
            422,
        );
    }
    let body = serde_json::to_vec(&RejectReviewInput {
        reason_code: input.reason_code,
        note: note.to_owned(),
    })?;
    let response = upstream::app_store(
        &ctx.env,
        &account.id,
        Method::Post,
        &format!("/v1/admin/releases/{release_id}/reject"),
        Some(body),
    )
    .await?;
    if response.status_code() < 400 {
        store::record_review_action(
            &ctx.env.d1("DB")?,
            &account.id,
            "app_store.release.rejected",
            release_id,
            audit_context.ip_address.as_deref(),
            audit_context.user_agent.as_deref(),
            audit_context.cf_ray.as_deref(),
            now(),
        )
        .await?;
    }
    Ok(response)
}

async fn route(req: Request, env: Env) -> Result<Response> {
    Router::new()
        .get_async("/health", |_, _| async { health_response() })
        .options_async("/health", |_, _| async { health_preflight() })
        .get_async("/v1/auth/start", auth_start)
        .get_async("/v1/auth/callback", auth_callback)
        .post_async("/v1/session/logout", logout)
        .get_async("/v1/session/me", me)
        .get_async("/v1/developers", proxy_route)
        .post_async("/v1/developers", proxy_route)
        .get_async("/v1/developers/:developer_id", proxy_route)
        .get_async("/v1/developers/:developer_id/members", proxy_route)
        .post_async("/v1/developers/:developer_id/members", proxy_route)
        .patch_async(
            "/v1/developers/:developer_id/members/:member_id",
            proxy_route,
        )
        .delete_async(
            "/v1/developers/:developer_id/members/:member_id",
            proxy_route,
        )
        .get_async("/v1/developer-creation-requests", proxy_route)
        .post_async("/v1/developer-creation-requests", proxy_route)
        .get_async("/v1/developers/:developer_id/certificates", proxy_route)
        .patch_async(
            "/v1/developers/:developer_id/certificates/:certificate_id",
            proxy_route,
        )
        .get_async("/v1/certificates/:certificate_id", proxy_route)
        .get_async("/v1/developer-reviews", developer_review_queue)
        .get_async("/v1/management/audit-logs", management_audit_logs)
        .post_async(
            "/v1/developer-reviews/:kind/:resource_id/:action",
            developer_review_action,
        )
        .get_async("/v1/app-store/reviews", review_list)
        .get_async(
            "/v1/app-store/developers/:developer_id/bundle-ids",
            app_store_developer_proxy,
        )
        .post_async(
            "/v1/app-store/developers/:developer_id/bundle-ids",
            app_store_developer_proxy,
        )
        .get_async(
            "/v1/app-store/developers/:developer_id/apps",
            app_store_developer_proxy,
        )
        .post_async(
            "/v1/app-store/developers/:developer_id/apps",
            app_store_developer_proxy,
        )
        .get_async(
            "/v1/app-store/developers/:developer_id/apps/:bundle_id",
            app_store_developer_proxy,
        )
        .patch_async(
            "/v1/app-store/developers/:developer_id/apps/:bundle_id",
            app_store_developer_proxy,
        )
        .get_async(
            "/v1/app-store/developers/:developer_id/apps/:bundle_id/releases",
            app_store_developer_proxy,
        )
        .post_async(
            "/v1/app-store/developers/:developer_id/apps/:bundle_id/releases",
            app_store_developer_proxy,
        )
        .get_async("/v1/app-store/packages", package_list)
        .post_async("/v1/app-store/packages/:bundle_id/:action", package_action)
        .get_async("/v1/app-store/reviews/:release_id", review_detail)
        .post_async("/v1/app-store/reviews/:release_id/approve", approve_review)
        .post_async("/v1/app-store/reviews/:release_id/reject", reject_review)
        .run(req, env)
        .await
}

#[event(fetch)]
pub async fn main(req: Request, env: Env, _ctx: Context) -> Result<Response> {
    match route(req, env).await {
        Ok(response) => Ok(response),
        Err(cause) => {
            console_error!(
                "{}",
                json!({"event":"request.failed","error":cause.to_string()})
            );
            error("INTERNAL_ERROR", "リクエストを完了できませんでした。", 500)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn api_body_limit_is_bounded() {
        assert_eq!(MAX_JSON_BODY_BYTES, 65_536);
    }

    #[test]
    fn app_store_admin_routes_are_not_exposed_directly() {
        let source = include_str!("lib.rs").to_ascii_lowercase();
        let production = source.split("#[cfg(test)]").next().unwrap_or_default();
        assert!(!production.contains(".post_async(\"/v1/admin/"));
        assert!(production.contains("/v1/app-store/reviews"));
        assert!(production.contains("/v1/developer-reviews"));
        assert!(!production.contains(".post_async(\"/v1/admin/"));
    }

    #[test]
    fn validates_release_ids_before_building_upstream_paths() {
        assert!(valid_release_id("rel_019f9d57"));
        assert!(!valid_release_id("../release"));
        assert!(!valid_release_id("release?status=approved"));
        assert!(valid_review_resource_id("019f9e5ac6687902b0e72fe53abfbef1"));
        assert!(valid_review_resource_id(
            "019f9e5a-c668-7902-b0e7-2fe53abfbef1"
        ));
    }

    #[test]
    fn security_admin_can_suspend_restore_and_revoke() {
        let source = include_str!("lib.rs");
        let production = source.split("#[cfg(test)]").next().unwrap_or_default();
        let app = include_str!("../public/assets/app.js");
        assert!(!production.contains("/v1/developers/:developer_id/certificates/issue"));
        assert!(production.contains("(\"certificates\", \"revoke\")"));
        assert!(production.contains("(\"certificates\", \"suspend\")"));
        assert!(production.contains("(\"certificates\", \"restore\")"));
        assert!(production.contains("(\"developers\", \"suspend\")"));
        assert!(production.contains("/v1/app-store/packages/:bundle_id/:action"));
        assert!(production.contains("/v1/admin/certificates/{resource_id}/revoke"));
        assert!(!production.contains("/v1/admin/certificate-requests"));
        assert!(!production.contains("developer_policy_grant"));
        assert!(valid_revocation_reason_code("key_compromise"));
        assert!(valid_revocation_reason_code("administrative"));
        assert!(!valid_revocation_reason_code("../revoke"));
        assert!(!app.contains("certificate-issue-form"));
        assert!(!app.contains("public_key_file"));
        assert!(!app.contains("mpkg_file"));
        assert!(app.contains("kome login"));
        assert!(app.contains("kome sign"));
        assert!(!app.contains("certificates/register"));
        assert!(!app.contains("certificate-requests"));
        assert!(app.contains("package-management-form"));
        assert!(app.contains("developerManagementCard"));
    }

    #[test]
    fn publishing_flow_uses_reserved_bundle_ids_and_active_certificates() {
        let app = include_str!("../public/assets/app.js");
        assert!(app.contains("bundleResult.bundle_ids"));
        assert!(app.contains("reservedBundleIds.map"));
        assert!(app.contains("developerApps.map"));
        assert!(app.contains("item.status === \"active\""));
        assert!(app.contains("scopeAllowsBundleId"));
        assert!(!app.contains("item.status === \"issued\" || item.status === \"valid\""));
        assert!(!app.contains("name=\"price_label\""));
        assert!(!app.contains("name=\"minimum_mochios_version\""));
        assert!(app.contains("App Storeの審査に提出しました。"));
        assert!(app.contains("App Storeへリリースを提出"));
        assert!(!app.contains("GitHub Releaseを登録"));
        assert!(!app.contains("審査が完了するまでお待ちください。"));
        assert!(!app.contains("Reviewer検証を実行してください"));
    }

    #[test]
    fn review_queue_shows_validation_pending_releases() {
        let source = include_str!("lib.rs");
        let production = source.split("#[cfg(test)]").next().unwrap_or_default();
        let app = include_str!("../public/assets/app.js");
        assert!(production.contains("\"queue\" | \"approved\" | \"rejected\""));
        assert!(production.contains("/v1/admin/releases?status={status}"));
        assert!(app.contains("機械検証待ち"));
        assert!(app.contains("release.submitted_at || release.created_at"));
        assert!(!app.contains("検証を通過したReleaseだけを表示します"));
    }

    #[test]
    fn administrator_features_have_a_dedicated_entry_page() {
        let app = include_str!("../public/assets/app.js");
        assert!(app.contains("href=\"#admin\""));
        assert!(app.contains("async function renderAdmin()"));
        assert!(app.contains("あなたの管理権限"));
        assert!(app.contains("管理画面の表示ルール"));
        assert!(app.contains("次に行うこと"));
        assert!(app.contains("表示されるもの"));
        assert!(app.contains("表示されないもの"));
        assert!(app.contains("管理の進め方"));
        assert!(app.contains("Release審査の手順"));
        assert!(app.contains("機械検証と内容審査は別の作業です"));
        assert!(app.contains("Reviewer用tokenは実行環境へ設定"));
        assert!(app.contains("承認するとStoreへ即時公開されます"));
        assert!(app.contains("通常のDeveloperとCertificateに事前審査はありません"));
        assert!(app.contains("失効は取り消せません"));
        assert!(app.contains("copy-reviewer-command"));
        assert!(app.contains("reviewerCommand(release.release_id)"));
        assert!(app.contains("appStoreReviewer || developerCaReviewer"));
        assert!(!app.contains(">${icon(\"security\")}Developer管理</a>"));
        assert!(!app.contains(">${icon(\"fact_check\")}App審査</a>"));
    }

    #[test]
    fn admin_history_is_searchable_and_does_not_hide_completed_releases() {
        let source = include_str!("lib.rs");
        let production = source.split("#[cfg(test)]").next().unwrap_or_default();
        let app = include_str!("../public/assets/app.js");
        assert!(production.contains("/v1/management/audit-logs"));
        assert!(app.contains("/v1/app-store/reviews?status=approved"));
        assert!(app.contains("/v1/app-store/reviews?status=rejected"));
        assert!(app.contains("data-table-search"));
        assert!(app.contains("applyManagementFilter"));
        assert!(app.contains("処理が完了したReleaseも一覧から消えません"));
        assert!(app.contains("async function renderAuditLogs()"));
    }

    #[test]
    fn successful_admin_mutations_record_trusted_connection_context() {
        let source = include_str!("lib.rs");
        let production = source.split("#[cfg(test)]").next().unwrap_or_default();
        assert!(production.contains("CF-Connecting-IPv6"));
        assert!(production.contains("CF-Connecting-IP"));
        assert!(production.contains("CF-Ray"));
        assert!(production.contains("User-Agent"));
        assert!(!production.contains("X-Forwarded-For"));
        assert_eq!(
            production.matches("request_audit_context(&req)?").count(),
            4
        );
        assert_eq!(production.matches("record_review_action(").count(), 4);
    }

    #[test]
    fn developer_certificates_have_editable_display_names() {
        let source = include_str!("lib.rs");
        let app = include_str!("../public/assets/app.js");
        assert!(source.contains("/v1/developers/:developer_id/certificates/:certificate_id"));
        assert!(app.contains("certificate-name-form"));
        assert!(app.contains("証明書名を更新しました"));
        assert!(app.contains("item.display_name"));
    }

    #[test]
    fn applications_have_an_editable_detail_page() {
        let source = include_str!("lib.rs");
        let app = include_str!("../public/assets/app.js");
        assert!(source.contains(".patch_async("));
        assert!(source.contains("/v1/app-store/developers/:developer_id/apps/:bundle_id"));
        assert!(app.contains("renderAppDetail(developerId, bundleId)"));
        assert!(app.contains("id=\"app-store-edit-form\""));
        assert!(app.contains("method: \"PATCH\""));
        assert!(app.contains("ストア情報を編集"));
        let index = include_str!("../public/index.html");
        assert!(index.contains("account_circle,add,apps,badge"));
    }

    #[test]
    fn strict_csp_is_not_bypassed_by_cloudflare_html_injection() {
        let headers = include_str!("../public/_headers");
        assert!(
            headers.contains("Cache-Control: public, max-age=0, must-revalidate, no-transform")
        );
        assert!(headers.contains("script-src 'self'"));
        assert!(!headers.contains("'unsafe-inline'"));
    }

    #[test]
    fn developer_ca_upstream_uses_only_signed_bearer_tokens() {
        let source = include_str!("upstream.rs");
        let developer_ca = source
            .split("pub async fn developer_ca(")
            .nth(1)
            .unwrap_or_default()
            .split("pub async fn app_store(")
            .next()
            .unwrap_or_default();
        assert!(developer_ca.contains("developer_ca_headers"));
        for forbidden in [
            "X-Admin-Token",
            "X-Admin-Account-ID",
            "X-Console-Service-Token",
            "X-Account-ID",
        ] {
            assert!(!developer_ca.contains(forbidden));
        }
    }
}
