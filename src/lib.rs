mod model;
mod security;
mod store;
mod upstream;

use model::Account;
use security::{
    AUTH_STATE_COOKIE, SESSION_COOKIE, constant_time_eq, expired_cookie, parse_cookie,
    random_token, secure_cookie,
};
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
        Some(account) => json_response(&json!({"account": account}), 200),
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
    fn no_admin_routes_are_exposed() {
        let source = include_str!("lib.rs").to_ascii_lowercase();
        let production = source.split("#[cfg(test)]").next().unwrap_or_default();
        assert!(!production.contains("/v1/admin/"));
    }
}
