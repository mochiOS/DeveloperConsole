use uuid::{NoContext, Timestamp, Uuid};
use worker::{D1Database, Result, wasm_bindgen::JsValue};

use crate::model::{SessionIssue, SessionRow};
use crate::security::{random_token, token_hash};

fn value(value: impl AsRef<str>) -> JsValue {
    JsValue::from_str(value.as_ref())
}

fn number(value: i64) -> JsValue {
    JsValue::from_f64(value as f64)
}

fn id(now: i64) -> String {
    Uuid::new_v7(Timestamp::from_unix(NoContext, now.max(0) as u64, 0)).to_string()
}

fn audit(
    db: &D1Database,
    account_id: Option<&str>,
    event_type: &str,
    now: i64,
) -> Result<worker::D1PreparedStatement> {
    db.prepare(
        "INSERT INTO audit_logs (id, account_id, event_type, created_at) VALUES (?1, ?2, ?3, ?4)",
    )
    .bind(&[
        value(id(now)),
        account_id.map(value).unwrap_or(JsValue::NULL),
        value(event_type),
        number(now),
    ])
}

pub async fn issue_session(
    db: &D1Database,
    account_id: &str,
    now: i64,
    ttl: i64,
) -> Result<SessionIssue> {
    let token = random_token()
        .map_err(|_| worker::Error::RustError("secure random generation failed".into()))?;
    let expires_at = now + ttl.max(60);
    db.batch(vec![
        db.prepare(
            "INSERT INTO sessions (id, account_id, token_hash, created_at, expires_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
        )
        .bind(&[
            value(id(now)),
            value(account_id),
            value(token_hash(&token)),
            number(now),
            number(expires_at),
        ])?,
        audit(db, Some(account_id), "session.created", now)?,
    ])
    .await?;
    Ok(SessionIssue { token })
}

pub async fn authenticate_session(
    db: &D1Database,
    token: &str,
    now: i64,
) -> Result<Option<SessionRow>> {
    let session = db
        .prepare(
            "SELECT id, account_id FROM sessions
             WHERE token_hash = ?1 AND revoked_at IS NULL AND expires_at > ?2",
        )
        .bind(&[value(token_hash(token)), number(now)])?
        .first::<SessionRow>(None)
        .await?;
    if let Some(ref session) = session {
        db.prepare("UPDATE sessions SET last_used_at = ?1 WHERE id = ?2")
            .bind(&[number(now), value(&session.id)])?
            .run()
            .await?;
    }
    Ok(session)
}

pub async fn revoke_session(db: &D1Database, token: &str, now: i64) -> Result<()> {
    let session = authenticate_session(db, token, now).await?;
    db.prepare("UPDATE sessions SET revoked_at = ?1 WHERE token_hash = ?2 AND revoked_at IS NULL")
        .bind(&[number(now), value(token_hash(token))])?
        .run()
        .await?;
    if let Some(session) = session {
        audit(db, Some(&session.account_id), "session.revoked", now)?
            .run()
            .await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_are_uuid_v7_without_system_clock_access() {
        let parsed = Uuid::parse_str(&id(1_700_000_000)).unwrap();
        assert_eq!(parsed.get_version_num(), 7);
    }

    #[test]
    fn schema_hashes_sessions_and_protects_audit_logs() {
        let schema = include_str!("../migrations/0001_console.sql");
        assert!(schema.contains("token_hash TEXT NOT NULL UNIQUE"));
        assert!(schema.contains("audit_logs_no_update"));
        assert!(!schema.contains("token TEXT"));
    }
}
