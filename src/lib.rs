mod model;
mod security;
mod store;
mod upstream;

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
    upstream::developer_ca(&ctx.env, &account.id, method, &path, body).await
}

fn valid_release_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 80
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
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
    upstream::app_store(
        &ctx.env,
        &account.id,
        Method::Get,
        "/v1/admin/releases?status=submitted",
        None,
    )
    .await
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
    value.len() == 36
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() || byte == b'-')
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

async fn developer_policy(req: Request, ctx: RouteContext<()>) -> Result<Response> {
    let account = match developer_reviewer_account(&req, &ctx.env).await? {
        Ok(account) => account,
        Err(response) => return Ok(response),
    };
    let developer_id = ctx.param("developer_id").map(String::as_str).unwrap_or("");
    if !valid_review_resource_id(developer_id) {
        return error("DEVELOPER_ID_INVALID", "Developer IDが無効です。", 422);
    }
    upstream::developer_ca_admin(
        &ctx.env,
        &account.id,
        Method::Get,
        &format!("/v1/admin/developers/{developer_id}/policy"),
        None,
    )
    .await
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PolicyValueInput {
    value: String,
}

fn valid_policy_value(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_' | b'*'))
}

async fn developer_policy_grant(mut req: Request, ctx: RouteContext<()>) -> Result<Response> {
    let account = match developer_reviewer_account(&req, &ctx.env).await? {
        Ok(account) => account,
        Err(response) => return Ok(response),
    };
    if !mutation_origin_allowed(&req, &ctx.env)? {
        return error("ORIGIN_INVALID", "リクエスト元を確認できません。", 403);
    }
    let developer_id = ctx.param("developer_id").map(String::as_str).unwrap_or("");
    if !valid_review_resource_id(developer_id) {
        return error("DEVELOPER_ID_INVALID", "Developer IDが無効です。", 422);
    }
    let bytes = req.bytes().await?;
    if bytes.len() > MAX_JSON_BODY_BYTES {
        return error("REQUEST_TOO_LARGE", "リクエストが大きすぎます。", 413);
    }
    let input: PolicyValueInput = match serde_json::from_slice::<PolicyValueInput>(&bytes) {
        Ok(input) if valid_policy_value(input.value.trim()) => input,
        _ => return error("POLICY_VALUE_INVALID", "権限値が無効です。", 422),
    };
    let value = input.value.trim();
    let kind = ctx.param("kind").map(String::as_str).unwrap_or("");
    let (path, body) = match kind {
        "package-scopes" => (
            format!("/v1/admin/developers/{developer_id}/package-scopes"),
            serde_json::to_vec(&json!({"scope": value}))?,
        ),
        "capabilities" => (
            format!("/v1/admin/developers/{developer_id}/capabilities"),
            serde_json::to_vec(&json!({"capability": value}))?,
        ),
        _ => return error("POLICY_KIND_INVALID", "権限種別が無効です。", 404),
    };
    let response =
        upstream::developer_ca_admin(&ctx.env, &account.id, Method::Post, &path, Some(body))
            .await?;
    if response.status_code() < 400 {
        store::record_review_action(
            &ctx.env.d1("DB")?,
            &account.id,
            &format!("developer_ca.policy.{kind}.granted"),
            now(),
        )
        .await?;
    }
    Ok(response)
}

async fn global_capability_enable(mut req: Request, ctx: RouteContext<()>) -> Result<Response> {
    let account = match developer_reviewer_account(&req, &ctx.env).await? {
        Ok(account) => account,
        Err(response) => return Ok(response),
    };
    if !mutation_origin_allowed(&req, &ctx.env)? {
        return error("ORIGIN_INVALID", "リクエスト元を確認できません。", 403);
    }
    let bytes = req.bytes().await?;
    if bytes.len() > MAX_JSON_BODY_BYTES {
        return error("REQUEST_TOO_LARGE", "リクエストが大きすぎます。", 413);
    }
    let input: PolicyValueInput = match serde_json::from_slice::<PolicyValueInput>(&bytes) {
        Ok(input) if valid_policy_value(input.value.trim()) => input,
        _ => return error("CAPABILITY_INVALID", "Capabilityが無効です。", 422),
    };
    let response = upstream::developer_ca_admin(
        &ctx.env,
        &account.id,
        Method::Post,
        "/v1/admin/global-capabilities",
        Some(serde_json::to_vec(
            &json!({"capability": input.value.trim()}),
        )?),
    )
    .await?;
    if response.status_code() < 400 {
        store::record_review_action(
            &ctx.env.d1("DB")?,
            &account.id,
            "developer_ca.policy.global_capability.enabled",
            now(),
        )
        .await?;
    }
    Ok(response)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DeveloperReviewActionInput {
    reason: Option<String>,
}

async fn developer_review_action(mut req: Request, ctx: RouteContext<()>) -> Result<Response> {
    let account = match developer_reviewer_account(&req, &ctx.env).await? {
        Ok(account) => account,
        Err(response) => return Ok(response),
    };
    if !mutation_origin_allowed(&req, &ctx.env)? {
        return error("ORIGIN_INVALID", "リクエスト元を確認できません。", 403);
    }
    let kind = ctx.param("kind").map(String::as_str).unwrap_or("");
    let resource_id = ctx.param("resource_id").map(String::as_str).unwrap_or("");
    let action = ctx.param("action").map(String::as_str).unwrap_or("");
    if !valid_review_resource_id(resource_id) {
        return error("RESOURCE_ID_INVALID", "審査対象IDが無効です。", 422);
    }
    let rejection = matches!(action, "reject");
    let reason = if rejection {
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
                "却下理由は1〜2000文字で入力してください。",
                422,
            );
        }
        Some(reason)
    } else {
        None
    };
    let (path, body) = match (kind, action) {
        ("developers", "verify") => (
            format!("/v1/admin/developers/{resource_id}/verification"),
            Some(serde_json::to_vec(
                &json!({"verification_status": "verified"}),
            )?),
        ),
        ("developers", "reject") => (
            format!("/v1/admin/developers/{resource_id}/verification"),
            Some(serde_json::to_vec(
                &json!({"verification_status": "rejected"}),
            )?),
        ),
        ("creation-requests", "approve") => (
            format!("/v1/admin/developer-creation-requests/{resource_id}/approve"),
            Some(b"{}".to_vec()),
        ),
        ("creation-requests", "reject") => (
            format!("/v1/admin/developer-creation-requests/{resource_id}/reject"),
            Some(serde_json::to_vec(&json!({"rejection_reason": reason}))?),
        ),
        ("certificate-requests", "issue") => (
            format!("/v1/admin/certificate-requests/{resource_id}/issue"),
            None,
        ),
        ("certificate-requests", "reject") => (
            format!("/v1/admin/certificate-requests/{resource_id}/reject"),
            Some(serde_json::to_vec(&json!({"rejection_reason": reason}))?),
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
            now(),
        )
        .await?;
    }
    Ok(response)
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct RejectReviewInput {
    message: String,
}

async fn reject_review(mut req: Request, ctx: RouteContext<()>) -> Result<Response> {
    let account = match reviewer_account(&req, &ctx.env).await? {
        Ok(account) => account,
        Err(response) => return Ok(response),
    };
    if !mutation_origin_allowed(&req, &ctx.env)? {
        return error("ORIGIN_INVALID", "リクエスト元を確認できません。", 403);
    }
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
    let message = input.message.trim();
    if message.is_empty() || message.len() > 2000 {
        return error(
            "VALIDATION_ERROR",
            "却下理由は1〜2000文字で入力してください。",
            422,
        );
    }
    let body = serde_json::to_vec(&RejectReviewInput {
        message: message.to_owned(),
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
        .post_async(
            "/v1/developers/:developer_id/certificate-requests",
            proxy_route,
        )
        .get_async("/v1/developers/:developer_id/certificates", proxy_route)
        .get_async("/v1/certificates/:certificate_id", proxy_route)
        .get_async("/v1/developer-reviews", developer_review_queue)
        .get_async(
            "/v1/developer-reviews/developers/:developer_id/policy",
            developer_policy,
        )
        .post_async(
            "/v1/developer-reviews/developers/:developer_id/policy/:kind",
            developer_policy_grant,
        )
        .post_async(
            "/v1/developer-reviews/global-capabilities",
            global_capability_enable,
        )
        .post_async(
            "/v1/developer-reviews/:kind/:resource_id/:action",
            developer_review_action,
        )
        .get_async("/v1/app-store/reviews", review_list)
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
    }

    #[test]
    fn developer_policy_routes_are_fixed_and_values_cannot_inject_paths() {
        let source = include_str!("lib.rs");
        assert!(source.contains("/v1/developer-reviews/developers/:developer_id/policy/:kind"));
        assert!(source.contains("/v1/developer-reviews/global-capabilities"));
        assert!(valid_policy_value("org.mochios.example"));
        assert!(valid_policy_value("window.create"));
        assert!(!valid_policy_value("../admin"));
        assert!(!valid_policy_value("window.create?override=true"));
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
