import test from "node:test";
import assert from "node:assert/strict";
import {
  InMemoryMemoryEngine,
  InMemoryMemoryRuntime,
  RandomMemoryIds,
  RealtimeMemoryClock,
  dispatchMorrowHttpRequest,
  type MemoryRuntime,
  type MorrowAuthenticator
} from "../src/index.js";

const scopes = [
  "consent:write",
  "retention:write",
  "memory:write",
  "memory:read",
  "memory:delete",
  "memory:export"
].join(" ");

test("TEST-API-001 HTTP primary flow stores and queries consent-scoped memory", async () => {
  const runtime = createRuntime();

  await post(runtime, "/v1/retention-rules", {
    memoryType: "preference",
    purpose: "assistant_personalization",
    ttlDays: 30,
    deletionMode: "soft_delete"
  });
  await post(runtime, "/v1/consent-receipts", {
    subjectId: "subject_api",
    purpose: "assistant_personalization",
    scope: ["preference"],
    expiresAt: "2099-01-01T00:00:00.000Z"
  });
  const createResponse = await post(runtime, "/v1/memories", {
    subjectId: "subject_api",
    type: "preference",
    purpose: "assistant_personalization",
    policyRef: "default-policy",
    content: "Prefers audit-friendly APIs.",
    source: { kind: "user_statement", reference: "message_api" },
    confidence: 0.9,
    classification: "sensitive"
  }, "idem-api-1");

  assert.equal(createResponse.statusCode, 200);

  const queryResponse = await post(runtime, "/v1/memories/query", {
    subjectId: "subject_api",
    type: "preference",
    purpose: "assistant_personalization",
    policyRef: "default-policy"
  });

  assert.equal(queryResponse.statusCode, 200);
  const queryBody = queryResponse.body as {
    readonly data: { readonly memories: readonly unknown[] };
  };
  assert.equal(queryBody.data.memories.length, 1);
});

test("TEST-API-006 deletion request and subject export complete the public API flow", async () => {
  const runtime = createRuntime();
  await post(runtime, "/v1/retention-rules", {
    memoryType: "preference",
    purpose: "assistant_personalization",
    ttlDays: 30,
    deletionMode: "soft_delete"
  });
  await post(runtime, "/v1/consent-receipts", {
    subjectId: "subject_api",
    purpose: "assistant_personalization",
    scope: ["preference"],
    expiresAt: "2099-01-01T00:00:00.000Z"
  });
  const createResponse = await post(runtime, "/v1/memories", {
    subjectId: "subject_api",
    type: "preference",
    purpose: "assistant_personalization",
    policyRef: "default-policy",
    content: "Prefers exportable memories.",
    source: { kind: "user_statement", reference: "message_api" },
    confidence: 0.9,
    classification: "sensitive"
  }, "idem-api-export");
  const created = createResponse.body as { readonly data: { readonly id: string } };

  const exportBefore = await dispatchMorrowHttpRequest(runtime, authenticated(), {
    method: "GET",
    path: "/v1/subjects/subject_api/export",
    headers: authorizedHeaders()
  });
  const exportBeforeBody = exportBefore.body as { readonly data: { readonly memories: readonly unknown[] } };
  assert.equal(exportBeforeBody.data.memories.length, 1);

  const deleteResponse = await post(runtime, "/v1/deletion-requests", {
    memoryId: created.data.id,
    reason: "subject-request"
  }, "idem-api-delete");

  assert.equal(deleteResponse.statusCode, 200);

  const exportAfter = await dispatchMorrowHttpRequest(runtime, authenticated(), {
    method: "GET",
    path: "/v1/subjects/subject_api/export",
    headers: authorizedHeaders()
  });
  const exportAfterBody = exportAfter.body as { readonly data: { readonly memories: readonly unknown[] } };
  assert.equal(exportAfterBody.data.memories.length, 0);
});

test("TEST-API-002 HTTP rejects an invalid principal before state change", async () => {
  const response = await dispatchMorrowHttpRequest(createRuntime(), authenticated(undefined), {
    method: "POST",
    path: "/v1/retention-rules",
    headers: {
      "content-type": "application/json",
      "x-tenant-id": "tenant_api"
    },
    bodyText: JSON.stringify({
      memoryType: "preference",
      purpose: "assistant_personalization",
      ttlDays: 30,
      deletionMode: "soft_delete"
    })
  });
  const body = response.body as { readonly error: { readonly code: string } };

  assert.equal(response.statusCode, 401);
  assert.equal(body.error.code, "AUTHENTICATION_REQUIRED");
});

test("TEST-API-003 health check is public and does not require authenticator", async () => {
  const response = await dispatchMorrowHttpRequest(createRuntime(), undefined, {
    method: "GET",
    path: "/healthz",
    headers: {}
  });
  const body = response.body as { readonly data: { readonly status: string } };

  assert.equal(response.statusCode, 200);
  assert.equal(body.data.status, "ok");
});

test("TEST-API-003A readiness is public and fails closed when a dependency probe fails", async () => {
  const ready = await dispatchMorrowHttpRequest(createRuntime(), undefined, {
    method: "GET",
    path: "/readyz",
    headers: {}
  }, async () => undefined);
  const unavailable = await dispatchMorrowHttpRequest(createRuntime(), undefined, {
    method: "GET",
    path: "/readyz",
    headers: { "x-correlation-id": "corr_unavailable" }
  }, async () => { throw new Error("database connection details must not be exposed"); });
  const unavailableBody = unavailable.body as { readonly error: { readonly code: string; readonly correlationId: string } };

  assert.equal(ready.statusCode, 200);
  assert.equal((ready.body as { readonly data: { readonly status: string } }).data.status, "ready");
  assert.equal(unavailable.statusCode, 503);
  assert.equal(unavailableBody.error.code, "DEPENDENCY_UNAVAILABLE");
  assert.equal(unavailableBody.error.correlationId, "corr_unavailable");
});

test("TEST-API-004 malformed JSON fails with stable validation error", async () => {
  const response = await dispatchMorrowHttpRequest(createRuntime(), authenticated(), {
    method: "POST",
    path: "/v1/retention-rules",
    headers: authorizedHeaders(),
    bodyText: "{not-json"
  });
  const body = response.body as { readonly error: { readonly code: string } };

  assert.equal(response.statusCode, 422);
  assert.equal(body.error.code, "VALIDATION_FAILED");
});

test("TEST-API-005 unsupported enum values are rejected before persistence", async () => {
  const response = await post(createRuntime(), "/v1/retention-rules", {
    memoryType: "unknown",
    purpose: "assistant_personalization",
    ttlDays: 30,
    deletionMode: "soft_delete"
  });

  const body = response.body as { readonly error: { readonly code: string } };
  assert.equal(response.statusCode, 422);
  assert.equal(body.error.code, "VALIDATION_FAILED");
});

test("TEST-API-007 HTTP fails closed when no authenticator is configured", async () => {
  const response = await dispatchMorrowHttpRequest(createRuntime(), undefined, {
    method: "POST",
    path: "/v1/retention-rules",
    headers: authorizedHeaders(),
    bodyText: JSON.stringify({
      memoryType: "preference",
      purpose: "assistant_personalization",
      ttlDays: 30,
      deletionMode: "soft_delete"
    })
  });

  assert.equal(response.statusCode, 401);
});

test("TEST-API-008 HTTP fails closed when authentication throws", async () => {
  const response = await dispatchMorrowHttpRequest(createRuntime(), {
    async authenticate(): Promise<undefined> {
      throw new Error("provider unavailable");
    }
  }, {
    method: "POST",
    path: "/v1/retention-rules",
    headers: authorizedHeaders(),
    bodyText: "{}"
  });

  assert.equal(response.statusCode, 401);
});

test("TEST-API-009 HTTP rejects a spoofed tenant header", async () => {
  const response = await dispatchMorrowHttpRequest(createRuntime(), authenticated(), {
    method: "POST",
    path: "/v1/retention-rules",
    headers: { ...authorizedHeaders(), "x-tenant-id": "tenant_spoofed" },
    bodyText: "{}"
  });

  assert.equal(response.statusCode, 403);
});

test("TEST-API-010 HTTP does not accept scopes from request headers", async () => {
  const response = await dispatchMorrowHttpRequest(createRuntime(), authenticated({ scopes: [] }), {
    method: "POST",
    path: "/v1/retention-rules",
    headers: authorizedHeaders(),
    bodyText: JSON.stringify({
      memoryType: "preference",
      purpose: "assistant_personalization",
      ttlDays: 30,
      deletionMode: "soft_delete"
    })
  });

  assert.equal(response.statusCode, 403);
});

test("TEST-API-011 HTTP rejects malformed principals from an external authenticator", async () => {
  const response = await dispatchMorrowHttpRequest(createRuntime(), {
    async authenticate() {
      return {
        tenantId: "tenant_api",
        actorId: "actor_api",
        scopes: "memory:read"
      } as unknown as { readonly tenantId: string; readonly actorId: string; readonly scopes: readonly string[] };
    }
  }, {
    method: "POST",
    path: "/v1/retention-rules",
    headers: authorizedHeaders(),
    bodyText: "{}"
  });

  assert.equal(response.statusCode, 401);
});

test("TEST-API-012 HTTP rejects oversized request bodies before authentication", async () => {
  const response = await dispatchMorrowHttpRequest(createRuntime(), undefined, {
    method: "POST",
    path: "/v1/retention-rules",
    headers: {},
    bodyText: "x".repeat(1_048_577)
  });

  assert.equal(response.statusCode, 413);
});

async function post(
  runtime: MemoryRuntime,
  path: string,
  body: Record<string, unknown>,
  idempotencyKey = "idem-test"
) {
  return dispatchMorrowHttpRequest(runtime, authenticated(), {
    method: "POST",
    path,
    headers: authorizedHeaders(idempotencyKey),
    bodyText: JSON.stringify(body)
  });
}

function authorizedHeaders(idempotencyKey = "idem-test"): Record<string, string> {
  return {
    authorization: "Bearer actor_api",
    "content-type": "application/json",
    "idempotency-key": idempotencyKey,
    "x-correlation-id": "corr_api",
    "x-morrow-scopes": scopes,
    "x-tenant-id": "tenant_api"
  };
}

function authenticated(overrides: Partial<{ readonly scopes: readonly string[] }> = {}): MorrowAuthenticator {
  return {
    async authenticate(authorization): Promise<{ readonly tenantId: string; readonly actorId: string; readonly scopes: readonly string[] } | undefined> {
      if (authorization !== "Bearer actor_api") {
        return undefined;
      }
      return {
        tenantId: "tenant_api",
        actorId: "actor_api",
        scopes: overrides.scopes ?? scopes.split(" ")
      };
    }
  };
}

function createRuntime(): MemoryRuntime {
  return new InMemoryMemoryRuntime(new InMemoryMemoryEngine(new RealtimeMemoryClock(), new RandomMemoryIds()));
}
