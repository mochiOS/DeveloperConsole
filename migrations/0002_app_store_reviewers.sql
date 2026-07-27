CREATE TABLE app_store_reviewers (
    account_id TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    created_by TEXT
);

CREATE INDEX idx_app_store_reviewers_created_at
    ON app_store_reviewers(created_at);
