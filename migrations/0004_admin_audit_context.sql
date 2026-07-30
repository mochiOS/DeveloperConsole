ALTER TABLE audit_logs ADD COLUMN resource_id TEXT;
ALTER TABLE audit_logs ADD COLUMN ip_address TEXT
    CHECK (ip_address IS NULL OR length(ip_address) <= 45);
ALTER TABLE audit_logs ADD COLUMN user_agent TEXT
    CHECK (user_agent IS NULL OR length(user_agent) <= 512);
ALTER TABLE audit_logs ADD COLUMN cf_ray TEXT
    CHECK (cf_ray IS NULL OR length(cf_ray) <= 128);

CREATE INDEX idx_audit_logs_event_created
    ON audit_logs(event_type, created_at DESC);

CREATE INDEX idx_audit_logs_resource_created
    ON audit_logs(resource_id, created_at DESC);
