import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import test from "node:test";

import {
  createMorrowApiServer,
  createPostgresMemoryRuntime,
  RandomMemoryIds,
  RealtimeMemoryClock,
  type MorrowAuthenticator
} from "../src/index.js";
import { migrateDatabase } from "../src/database-migrations.js";

const databaseUrl = process.env.MORROW_TEST_DATABASE_URL;
const postgresTest = databaseUrl === undefined || databaseUrl.trim().length === 0 ? test.skip : test;

postgresTest("TEST-E2E-001 PostgreSQL HTTP flow enforces migration order and tenant isolation", async () => {
  if (databaseUrl === undefined || databaseUrl.trim().length === 0) {
    throw new Error("MORROW_TEST_DATABASE_URL is required for the PostgreSQL HTTP E2E test.");
  }
  const { pool, runtime } = createPostgresMemoryRuntime(
    { connectionString: databaseUrl },
    new RandomMemoryIds(),
    new RealtimeMemoryClock()
  );
  const migrationsDirectory = resolve(process.cwd(), "migrations");
  const tenantA = `tenant_e2e_a_${randomUUID()}`;
  const tenantB = `tenant_e2e_b_${randomUUID()}`;
  const subjectId = `subject_e2e_${randomUUID()}`;
  const otherSubjectId = `subject_e2e_other_${randomUUID()}`;
  const authenticator = authenticatorFor({ tenantA, tenantB }, subjectId, otherSubjectId);
  const server = createMorrowApiServer({ runtime, authenticator });

  try {
    await migrateDatabase(pool, migrationsDirectory);
    const migrationRows = await pool.query<{ readonly filename: string }>(
      "SELECT filename FROM schema_migrations ORDER BY filename ASC"
    );
    assert.deepEqual(migrationRows.rows.map(({ filename }) => filename), [
      "001_initial.sql",
      "002_postgres_runtime.sql",
      "003_subject_authorization.sql"
    ]);

    const baseUrl = await listen(server);
    const retention = await request(baseUrl, "POST", "/v1/retention-rules", tenantA, {
      memoryType: "preference",
      purpose: "assistant_personalization",
      ttlDays: 30,
      deletionMode: "soft_delete"
    });
    assert.equal(retention.status, 200);

    const consent = await request(baseUrl, "POST", "/v1/consent-receipts", tenantA, {
      subjectId,
      purpose: "assistant_personalization",
      scope: ["preference"],
      expiresAt: "2099-01-01T00:00:00.000Z"
    });
    assert.equal(consent.status, 200);

    const memoryPayload = {
      subjectId,
      type: "preference",
      purpose: "assistant_personalization",
      policyRef: "default-policy",
      content: "Prefers PostgreSQL-backed memory.",
      source: { kind: "user_statement", reference: "e2e-test" },
      confidence: 0.95,
      classification: "sensitive"
    };
    const memory = await request(baseUrl, "POST", "/v1/memories", tenantA, memoryPayload, "memory-e2e");
    assert.equal(memory.status, 200);
    const memoryId = bodyData<{ readonly id: string }>(memory).id;

    const query = await request(baseUrl, "POST", "/v1/memories/query", tenantA, {
      subjectId,
      type: "preference",
      purpose: "assistant_personalization",
      policyRef: "default-policy"
    });
    assert.equal(query.status, 200);
    assert.equal(bodyData<{ readonly memories: readonly unknown[] }>(query).memories.length, 1);

    const otherSubjectQuery = await requestAs(baseUrl, "POST", "/v1/memories/query", "tenant-a-other", {
      subjectId,
      type: "preference",
      purpose: "assistant_personalization",
      policyRef: "default-policy"
    });
    assert.equal(otherSubjectQuery.status, 403);
    assert.equal(errorCode(otherSubjectQuery), "TENANT_SCOPE_DENIED");

    const delegatedQuery = await requestAs(baseUrl, "POST", "/v1/memories/query", "tenant-a-delegated", {
      subjectId,
      type: "preference",
      purpose: "assistant_personalization",
      policyRef: "default-policy"
    });
    assert.equal(delegatedQuery.status, 200);
    assert.equal(bodyData<{ readonly memories: readonly unknown[] }>(delegatedQuery).memories.length, 1);

    const expiredDelegationQuery = await requestAs(baseUrl, "POST", "/v1/memories/query", "tenant-a-expired", {
      subjectId,
      type: "preference",
      purpose: "assistant_personalization",
      policyRef: "default-policy"
    });
    assert.equal(expiredDelegationQuery.status, 403);
    assert.equal(errorCode(expiredDelegationQuery), "TENANT_SCOPE_DENIED");

    const existingOtherSubjectRevoke = await requestAs(
      baseUrl,
      "POST",
      `/v1/memories/${memoryId}/revoke`,
      "tenant-a-other",
      { reason: "blocked" },
      "other-subject-revoke"
    );
    const absentOtherSubjectRevoke = await requestAs(
      baseUrl,
      "POST",
      "/v1/memories/mem_absent/revoke",
      "tenant-a-other",
      { reason: "blocked" },
      "absent-subject-revoke"
    );
    assert.equal(existingOtherSubjectRevoke.status, 404);
    assert.equal(absentOtherSubjectRevoke.status, existingOtherSubjectRevoke.status);
    assert.equal(errorCode(absentOtherSubjectRevoke), errorCode(existingOtherSubjectRevoke));

    const mismatchedSubjectReplay = await requestAs(baseUrl, "POST", "/v1/memories", "tenant-a-other", {
      ...memoryPayload,
      subjectId: otherSubjectId
    }, "memory-e2e");
    assert.equal(mismatchedSubjectReplay.status, 403);
    assert.equal(errorCode(mismatchedSubjectReplay), "TENANT_SCOPE_DENIED");

    await pool.query(
      `INSERT INTO idempotency_keys (tenant_id, actor_id, idempotency_key, subject_id, operation, request_hash, resource_id, created_at)
       VALUES ($1, $2, $3, NULL, $4, $5, $6, NOW())`,
      [tenantA, `${tenantA}-actor`, "legacy-subject-evidence", "memory.write", "legacy-hash", memoryId]
    );
    const legacyReplay = await request(baseUrl, "POST", "/v1/memories", tenantA, memoryPayload, "legacy-subject-evidence");
    assert.equal(legacyReplay.status, 409);
    assert.equal(errorCode(legacyReplay), "VERSION_CONFLICT");

    const exportBeforeDeletion = await request(baseUrl, "GET", `/v1/subjects/${subjectId}/export`, tenantA);
    assert.equal(exportBeforeDeletion.status, 200);
    assert.equal(bodyData<{ readonly memories: readonly unknown[] }>(exportBeforeDeletion).memories.length, 1);

    const otherTenantExport = await request(baseUrl, "GET", `/v1/subjects/${subjectId}/export`, tenantB);
    assert.equal(otherTenantExport.status, 200);
    assert.deepEqual(bodyData<{ readonly memories: readonly unknown[] }>(otherTenantExport).memories, []);

    await pool.query("UPDATE consent_receipts SET expires_at = $1 WHERE tenant_id = $2", ["2000-01-01T00:00:00.000Z", tenantA]);
    const replayAfterConsentExpiry = await request(baseUrl, "POST", "/v1/memories", tenantA, memoryPayload, "memory-e2e");
    assert.equal(replayAfterConsentExpiry.status, 200);
    assert.equal(bodyData<{ readonly id: string }>(replayAfterConsentExpiry).id, memoryId);

    const deletion = await request(baseUrl, "POST", "/v1/deletion-requests", tenantA, {
      memoryId,
      reason: "subject-request"
    }, "deletion-e2e");
    assert.equal(deletion.status, 200);

    const exportAfterDeletion = await request(baseUrl, "GET", `/v1/subjects/${subjectId}/export`, tenantA);
    assert.equal(exportAfterDeletion.status, 200);
    assert.deepEqual(bodyData<{ readonly memories: readonly unknown[] }>(exportAfterDeletion).memories, []);

    await request(baseUrl, "POST", "/v1/retention-rules", tenantA, {
      memoryType: "fact",
      purpose: "deletion-test",
      ttlDays: 30,
      deletionMode: "hard_delete"
    });
    await request(baseUrl, "POST", "/v1/consent-receipts", tenantA, {
      subjectId,
      purpose: "deletion-test",
      scope: ["fact"],
      expiresAt: "2099-01-01T00:00:00.000Z"
    });
    const hardDeletedMemory = await request(baseUrl, "POST", "/v1/memories", tenantA, {
      subjectId,
      type: "fact",
      purpose: "deletion-test",
      policyRef: "default-policy",
      content: "This row must be physically deleted.",
      source: { kind: "user_statement", reference: "e2e-test" },
      confidence: 0.95,
      classification: "sensitive"
    }, "hard-delete-memory");
    const hardDeletedMemoryId = bodyData<{ readonly id: string }>(hardDeletedMemory).id;
    const hardDeleteRevoke = await request(
      baseUrl,
      "POST",
      `/v1/memories/${hardDeletedMemoryId}/revoke`,
      tenantA,
      { reason: "revoke-before-hard-delete" },
      "hard-delete-revoke"
    );
    assert.equal(hardDeleteRevoke.status, 200);
    const hardDeletion = await request(baseUrl, "POST", "/v1/deletion-requests", tenantA, {
      memoryId: hardDeletedMemoryId,
      reason: "subject-hard-delete"
    }, "hard-delete-request");
    assert.equal(hardDeletion.status, 200);
    const hardDeletionReplay = await request(baseUrl, "POST", "/v1/deletion-requests", tenantA, {
      memoryId: hardDeletedMemoryId,
      reason: "subject-hard-delete"
    }, "hard-delete-request");
    assert.equal(hardDeletionReplay.status, 200);
    assert.equal(
      bodyData<{ readonly id: string }>(hardDeletionReplay).id,
      bodyData<{ readonly id: string }>(hardDeletion).id
    );
    const hardDeletionConflict = await request(baseUrl, "POST", "/v1/deletion-requests", tenantA, {
      memoryId: hardDeletedMemoryId,
      reason: "different-reason"
    }, "hard-delete-request");
    assert.equal(hardDeletionConflict.status, 409);
    const physicalRow = await pool.query("SELECT id FROM memories WHERE id = $1", [hardDeletedMemoryId]);
    assert.equal(physicalRow.rows.length, 0);
  } finally {
    await close(server);
    await pool.end();
  }
});

function authenticatorFor(
  tenants: { readonly tenantA: string; readonly tenantB: string },
  subjectId: string,
  otherSubjectId: string
): MorrowAuthenticator {
  const scopes = [
    "retention:write",
    "consent:write",
    "memory:write",
    "memory:read",
    "memory:export",
    "memory:delete"
  ];
  return {
    async authenticate(authorization) {
      const token = authorization?.replace(/^Bearer /, "");
      if (token === "tenant-a") {
        return { tenantId: tenants.tenantA, actorId: `${tenants.tenantA}-actor`, scopes, subjectId };
      }
      if (token === "tenant-a-other") {
        return { tenantId: tenants.tenantA, actorId: `${tenants.tenantA}-actor`, scopes, subjectId: otherSubjectId };
      }
      if (token === "tenant-a-delegated" || token === "tenant-a-expired") {
        return {
          tenantId: tenants.tenantA,
          actorId: `${tenants.tenantA}-delegate`,
          scopes: ["memory:read"],
          subjectDelegations: [{
            subjectId,
            scopes: ["memory:read"],
            expiresAt: token === "tenant-a-delegated" ? "2099-01-01T00:00:00.000Z" : "2000-01-01T00:00:00.000Z"
          }]
        };
      }
      if (token === "tenant-b") {
        return { tenantId: tenants.tenantB, actorId: `${tenants.tenantB}-actor`, scopes, subjectId };
      }
      return undefined;
    }
  };
}

async function request(
  baseUrl: string,
  method: "GET" | "POST",
  path: string,
  tenantId: string,
  body?: Record<string, unknown>,
  idempotencyKey?: string
): Promise<{ readonly status: number; readonly body: unknown }> {
  const token = tenantId.includes("_a_") ? "tenant-a" : "tenant-b";
  return requestAs(baseUrl, method, path, token, body, idempotencyKey);
}

async function requestAs(
  baseUrl: string,
  method: "GET" | "POST",
  path: string,
  token: string,
  body?: Record<string, unknown>,
  idempotencyKey?: string
): Promise<{ readonly status: number; readonly body: unknown }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(idempotencyKey === undefined ? {} : { "idempotency-key": idempotencyKey })
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  return { status: response.status, body: await response.json() as unknown };
}

function errorCode(response: { readonly body: unknown }): string | undefined {
  return (response.body as { readonly error?: { readonly code?: string } }).error?.code;
}

function bodyData<T extends object>(response: { readonly body: unknown }): T {
  const body = response.body as { readonly data?: unknown };
  return body.data as T;
}

async function listen(server: ReturnType<typeof createMorrowApiServer>): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("PostgreSQL HTTP E2E server did not bind to a TCP address.");
  }
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: ReturnType<typeof createMorrowApiServer>): Promise<void> {
  if (!server.listening) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
  });
}
