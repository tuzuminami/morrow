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
  const store = new PostgresMemoryStore(
    tx,
    { nextId: (prefix) => `${prefix}_1` },
    { now: () => new Date("2026-07-05T00:00:00.000Z") }
  );

  await store.insertMemoryWithAudit(context, {
    subjectId: "subject_sql",
    type: "preference",
    purpose: "assistant_personalization",
    policyRef: "default-policy",
    content: "Prefers SQL-backed storage.",
    source: { kind: "user_statement", reference: "message_sql" },
    confidence: 0.9,
    classification: "sensitive",
    idempotencyKey: "idem_sql"
  }, new Date("2026-08-05T00:00:00.000Z"));

  assert.equal(tx.queries.length, 2);
  assert.match(tx.queries[0]?.sql ?? "", /INSERT INTO memories/);
  assert.match(tx.queries[1]?.sql ?? "", /INSERT INTO audit_events/);
  assert.equal(tx.queries[0]?.values[1], "tenant_sql");
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
    "assistant_personalization",
    "default-policy",
    new Date("2026-07-05T00:00:00.000Z")
  );

  const sql = tx.queries[0]?.sql ?? "";
  assert.match(sql, /WHERE tenant_id = \$1/);
  assert.match(sql, /AND subject_id = \$2/);
  assert.match(sql, /AND purpose = \$3/);
  assert.match(sql, /AND policy_ref = \$4/);
  assert.equal(tx.queries[0]?.values[0], "tenant_sql");
});

test("TEST-STORAGE-003 pooled transaction provider commits and releases clients", async () => {
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

test("TEST-STORAGE-004 pooled transaction provider rolls back and releases on failure", async () => {
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
