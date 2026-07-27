CREATE TABLE developer_ca_reviewers (
    account_id TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    created_by TEXT
);

CREATE INDEX idx_developer_ca_reviewers_created_at
    ON developer_ca_reviewers(created_at);
