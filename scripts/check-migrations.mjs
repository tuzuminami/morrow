import { readFileSync } from "node:fs";

const up = readFileSync("migrations/001_initial.sql", "utf8");
const down = readFileSync("migrations/001_initial.down.sql", "utf8");

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

if (failures.length > 0) {
  console.error("Migration check failed:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log("Migration check passed.");
