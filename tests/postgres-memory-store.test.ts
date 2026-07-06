import { createHash } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import {
  PooledSqlTransactionProvider,
  PostgresMemoryStore,
  ScriptedTransactionProvider,
  type MemoryTenantContext,
  type SqlPool,
  type SqlPoolClient,
  type SqlQueryResult
} from "../src/index.js";

const context: MemoryTenantContext = {
  tenantId: "tenant_sql",
  actorId: "actor_sql",
  scopes: ["memory:write", "memory:read"],
  correlationId: "corr_sql"
};

test("TEST-STORAGE-001 PostgreSQL insert uses transaction and writes memory plus audit", async () => {
  const tx = new ScriptedTransactionProvider();
  const input = {
    subjectId: "subject_sql",
    type: "preference" as const,
    purpose: "assistant_personalization",
    policyRef: "default-policy",
    content: "Prefers SQL-backed storage.",
    source: { kind: "user_statement" as const, reference: "message_sql" },
    confidence: 0.9,
    classification: "sensitive" as const,
    idempotencyKey: "idem_sql"
  };
  const store = new PostgresMemoryStore(
    tx,
    { nextId: (prefix) => `${prefix}_1` },
    { now: () => new Date("2026-07-05T00:00:00.000Z") }
  );

  await store.insertMemoryWithAudit(context, input, new Date("2026-08-05T00:00:00.000Z"));

  assert.equal(tx.queries.length, 4);
  assert.match(tx.queries[0]?.sql ?? "", /FROM idempotency_keys/);
  assert.match(tx.queries[1]?.sql ?? "", /INSERT INTO memories/);
  assert.match(tx.queries[2]?.sql ?? "", /INSERT INTO idempotency_keys/);
  assert.match(tx.queries[3]?.sql ?? "", /INSERT INTO audit_events/);
  assert.equal(tx.queries[1]?.values[1], "tenant_sql");
  assert.equal(tx.queries[2]?.values[4], memoryWriteRequestHash(input));
});

test("TEST-STORAGE-002 PostgreSQL query includes tenant predicate and scope fields", async () => {
  const tx = new ScriptedTransactionProvider();
  const store = new PostgresMemoryStore(
    tx,
    { nextId: (prefix) => `${prefix}_1` },
    { now: () => new Date("2026-07-05T00:00:00.000Z") }
  );

  await store.queryActiveMemories(
    context,
    "subject_sql",
    "preference",
    "assistant_personalization",
    "default-policy",
    new Date("2026-07-05T00:00:00.000Z")
  );

  const sql = tx.queries[0]?.sql ?? "";
  assert.match(sql, /WHERE tenant_id = \$1/);
  assert.match(sql, /AND subject_id = \$2/);
  assert.match(sql, /AND type = \$3/);
  assert.match(sql, /AND purpose = \$4/);
  assert.match(sql, /AND policy_ref = \$5/);
  assert.equal(tx.queries[0]?.values[0], "tenant_sql");
  assert.equal(tx.queries[0]?.values[2], "preference");
});

test("TEST-STORAGE-003 PostgreSQL insert returns existing memory for matching idempotency key", async () => {
  const input = {
    subjectId: "subject_sql",
    type: "preference" as const,
    purpose: "assistant_personalization",
    policyRef: "default-policy",
    content: "Prefers SQL-backed storage.",
    source: { kind: "user_statement" as const, reference: "message_sql" },
    confidence: 0.9,
    classification: "sensitive" as const,
    idempotencyKey: "idem_sql"
  };
  const tx = new ScriptedTransactionProvider([
    { rows: [{ resource_id: "mem_existing", request_hash: memoryWriteRequestHash(input) }] },
    { rows: [memoryRow("mem_existing", input)] }
  ]);
  const store = new PostgresMemoryStore(
    tx,
    { nextId: (prefix) => `${prefix}_1` },
    { now: () => new Date("2026-07-05T00:00:00.000Z") }
  );

  const memory = await store.insertMemoryWithAudit(context, input, new Date("2026-08-05T00:00:00.000Z"));

  assert.equal(memory.id, "mem_existing");
  assert.equal(tx.queries.length, 2);
  assert.match(tx.queries[0]?.sql ?? "", /FROM idempotency_keys/);
  assert.match(tx.queries[1]?.sql ?? "", /FROM memories/);
});

test("TEST-STORAGE-004 PostgreSQL insert rejects conflicting idempotency key", async () => {
  const input = {
    subjectId: "subject_sql",
    type: "preference" as const,
    purpose: "assistant_personalization",
    policyRef: "default-policy",
    content: "Prefers SQL-backed storage.",
    source: { kind: "user_statement" as const, reference: "message_sql" },
    confidence: 0.9,
    classification: "sensitive" as const,
    idempotencyKey: "idem_sql"
  };
  const tx = new ScriptedTransactionProvider([
    { rows: [{ resource_id: "mem_existing", request_hash: "different" }] }
  ]);
  const store = new PostgresMemoryStore(
    tx,
    { nextId: (prefix) => `${prefix}_1` },
    { now: () => new Date("2026-07-05T00:00:00.000Z") }
  );

  await assert.rejects(
    store.insertMemoryWithAudit(context, input, new Date("2026-08-05T00:00:00.000Z")),
    /Idempotency key conflicts/
  );
  assert.equal(tx.queries.length, 1);
});

test("TEST-STORAGE-005 pooled transaction provider commits and releases clients", async () => {
  const pool = new FakePool();
  const tx = new PooledSqlTransactionProvider(pool);

  const result = await tx.transaction(async (client) => {
    await client.query("SELECT 1", ["value"]);
    return "ok";
  });

  assert.equal(result, "ok");
  assert.deepEqual(pool.client.queries.map((query) => query.sql), ["BEGIN", "SELECT 1", "COMMIT"]);
  assert.equal(pool.client.released, true);
});

test("TEST-STORAGE-006 pooled transaction provider rolls back and releases on failure", async () => {
  const pool = new FakePool();
  const tx = new PooledSqlTransactionProvider(pool);

  await assert.rejects(
    tx.transaction(async () => {
      throw new Error("boom");
    }),
    /boom/
  );

  assert.deepEqual(pool.client.queries.map((query) => query.sql), ["BEGIN", "ROLLBACK"]);
  assert.equal(pool.client.released, true);
});

class FakePool implements SqlPool {
  readonly client = new FakeClient();

  async connect(): Promise<SqlPoolClient> {
    return this.client;
  }
}

function memoryRow(id: string, input: {
  readonly subjectId: string;
  readonly type: "preference";
  readonly purpose: string;
  readonly policyRef: string;
  readonly content: string;
  readonly source: { readonly kind: "user_statement"; readonly reference: string };
  readonly confidence: number;
  readonly classification: "sensitive";
}) {
  return {
    id,
    tenant_id: context.tenantId,
    subject_id: input.subjectId,
    type: input.type,
    purpose: input.purpose,
    policy_ref: input.policyRef,
    content: input.content,
    content_hash: createHash("sha256").update(input.content).digest("hex"),
    source: input.source,
    confidence: input.confidence,
    classification: input.classification,
    retention_expires_at: "2026-08-05T00:00:00.000Z",
    status: "active",
    created_at: "2026-07-05T00:00:00.000Z",
    created_by: context.actorId,
    updated_at: "2026-07-05T00:00:00.000Z",
    version: 1
  };
}

function memoryWriteRequestHash(input: {
  readonly subjectId: string;
  readonly type: "preference";
  readonly purpose: string;
  readonly policyRef: string;
  readonly content: string;
  readonly source: { readonly kind: "user_statement"; readonly reference: string };
  readonly confidence: number;
  readonly classification: "sensitive";
}): string {
  return createHash("sha256").update(JSON.stringify({
    operation: "memory.write",
    subjectId: input.subjectId,
    type: input.type,
    purpose: input.purpose,
    policyRef: input.policyRef,
    content: input.content,
    sourceKind: input.source.kind,
    sourceReference: input.source.reference,
    confidence: input.confidence,
    classification: input.classification
  })).digest("hex");
}

class FakeClient implements SqlPoolClient {
  readonly queries: Array<{ readonly sql: string; readonly values: readonly unknown[] }> = [];
  released = false;

  async query<Row = unknown>(sql: string, values: readonly unknown[] = []): Promise<SqlQueryResult<Row>> {
    this.queries.push({ sql, values });
    return { rows: [] };
  }

  release(): void {
    this.released = true;
  }
}
