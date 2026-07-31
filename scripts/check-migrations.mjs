import { readFileSync } from "node:fs";

const up = readFileSync("migrations/001_initial.sql", "utf8");
const down = readFileSync("migrations/001_initial.down.sql", "utf8");
const runtime = readFileSync("migrations/002_postgres_runtime.sql", "utf8");
const subjectAuthorization = readFileSync("migrations/003_subject_authorization.sql", "utf8");

const requiredTables = [
  "consent_receipts",
  "retention_rules",
  "memories",
  "idempotency_keys",
  "deletion_requests",
  "audit_events",
  "outbox_events"
];

const failures = [];

for (const table of requiredTables) {
  if (!new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`, "i").test(up)) {
    failures.push(`missing CREATE TABLE for ${table}`);
  }
  if (!new RegExp(`DROP TABLE IF EXISTS ${table}\\b`, "i").test(down)) {
    failures.push(`missing DROP TABLE rollback for ${table}`);
  }
}

if (!/ON memories \(tenant_id, subject_id, type, purpose, policy_ref, status, retention_expires_at\)/i.test(up)) {
  failures.push("memories_scope_idx must include tenant, subject, type, purpose, policy, status, and retention expiry");
}

if (!/PRIMARY KEY \(tenant_id, actor_id, idempotency_key\)/i.test(up)) {
  failures.push("idempotency_keys must be scoped by tenant, actor, and idempotency key");
}

if (!/DROP INDEX IF EXISTS memories_scope_idx/i.test(down)) {
  failures.push("rollback must drop memories_scope_idx");
}

for (const index of [
  "consent_receipts_scope_v1_idx",
  "audit_events_tenant_v1_idx",
  "idempotency_keys_tenant_v1_idx"
]) {
  if (!new RegExp(`CREATE INDEX IF NOT EXISTS ${index}\\b`, "i").test(runtime)) {
    failures.push(`missing V1 runtime index ${index}`);
  }
}

if (!/ADD COLUMN IF NOT EXISTS subject_id TEXT/i.test(subjectAuthorization)) {
  failures.push("subject authorization migration must add idempotency subject evidence");
}

if (!/idempotency_keys_subject_auth_v1_idx/i.test(subjectAuthorization)) {
  failures.push("subject authorization migration must index idempotency subject evidence");
}

if (failures.length > 0) {
  console.error("Migration check failed:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log("Migration check passed.");
