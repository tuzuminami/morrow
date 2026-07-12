CREATE INDEX IF NOT EXISTS consent_receipts_scope_v1_idx
  ON consent_receipts (tenant_id, subject_id, purpose, expires_at)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS audit_events_tenant_v1_idx
  ON audit_events (tenant_id, occurred_at, id);

CREATE INDEX IF NOT EXISTS idempotency_keys_tenant_v1_idx
  ON idempotency_keys (tenant_id, actor_id, created_at);

ALTER TABLE memories
  ADD CONSTRAINT memories_content_size_v1_check
  CHECK (octet_length(content) <= 16384);
