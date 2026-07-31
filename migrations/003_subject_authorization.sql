ALTER TABLE idempotency_keys
  ADD COLUMN IF NOT EXISTS subject_id TEXT;

CREATE INDEX IF NOT EXISTS idempotency_keys_subject_auth_v1_idx
  ON idempotency_keys (tenant_id, actor_id, subject_id, created_at);
