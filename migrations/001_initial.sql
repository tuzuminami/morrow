CREATE TABLE IF NOT EXISTS consent_receipts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  purpose TEXT NOT NULL,
  scope JSONB NOT NULL,
  granted_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS retention_rules (
  tenant_id TEXT NOT NULL,
  memory_type TEXT NOT NULL,
  purpose TEXT NOT NULL,
  ttl_days INTEGER NOT NULL CHECK (ttl_days > 0),
  deletion_mode TEXT NOT NULL,
  PRIMARY KEY (tenant_id, memory_type, purpose)
);

CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  type TEXT NOT NULL,
  purpose TEXT NOT NULL,
  policy_ref TEXT NOT NULL,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  source JSONB NOT NULL,
  confidence NUMERIC NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  classification TEXT NOT NULL,
  retention_expires_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  created_by TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  version INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS memories_scope_idx
  ON memories (tenant_id, subject_id, type, purpose, policy_ref, status, retention_expires_at);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  tenant_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  operation TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, actor_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS deletion_requests (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  memory_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  created_by TEXT NOT NULL,
  correlation_id TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS deletion_requests_scope_idx
  ON deletion_requests (tenant_id, memory_id, status, created_at);

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  action TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  before_hash TEXT,
  after_hash TEXT,
  occurred_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS outbox_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  delivered_at TIMESTAMPTZ
);
