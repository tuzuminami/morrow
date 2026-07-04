import test from "node:test";
import assert from "node:assert/strict";
import { InMemoryMemoryEngine, RandomMemoryIds, RealtimeMemoryClock, dispatchMorrowHttpRequest } from "../src/index.ts";

const scopes = [
  "consent:write",
  "retention:write",
  "memory:write",
  "memory:read",
  "memory:delete",
  "memory:export"
].join(" ");

test("TEST-API-001 HTTP primary flow stores and queries consent-scoped memory", async () => {
  const engine = createEngine();

  await post(engine, "/v1/retention-rules", {
    memoryType: "preference",
    purpose: "assistant_personalization",
    ttlDays: 30,
    deletionMode: "soft_delete"
  });
  await post(engine, "/v1/consent-receipts", {
    subjectId: "subject_api",
    purpose: "assistant_personalization",
    scope: ["preference"],
    expiresAt: "2099-01-01T00:00:00.000Z"
  });
  const createResponse = await post(engine, "/v1/memories", {
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

  const queryResponse = await post(engine, "/v1/memories/query", {
    subjectId: "subject_api",
    purpose: "assistant_personalization",
    policyRef: "default-policy"
  });

  assert.equal(queryResponse.statusCode, 200);
  const queryBody = queryResponse.body as {
    readonly data: { readonly memories: readonly unknown[] };
  };
  assert.equal(queryBody.data.memories.length, 1);
});

test("TEST-API-002 HTTP rejects missing authorization before state change", async () => {
  const response = await dispatchMorrowHttpRequest(createEngine(), {
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

test("TEST-API-003 health check is public and does not require tenant headers", async () => {
  const response = await dispatchMorrowHttpRequest(createEngine(), {
    method: "GET",
    path: "/healthz",
    headers: {}
  });
  const body = response.body as { readonly data: { readonly status: string } };

  assert.equal(response.statusCode, 200);
  assert.equal(body.data.status, "ok");
});

test("TEST-API-004 malformed JSON fails with stable validation error", async () => {
  const response = await dispatchMorrowHttpRequest(createEngine(), {
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
  const response = await post(createEngine(), "/v1/retention-rules", {
    memoryType: "unknown",
    purpose: "assistant_personalization",
    ttlDays: 30,
    deletionMode: "soft_delete"
  });

  const body = response.body as { readonly error: { readonly code: string } };
  assert.equal(response.statusCode, 422);
  assert.equal(body.error.code, "VALIDATION_FAILED");
});

async function post(
  engine: InMemoryMemoryEngine,
  path: string,
  body: Record<string, unknown>,
  idempotencyKey = "idem-test"
) {
  return dispatchMorrowHttpRequest(engine, {
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

function createEngine(): InMemoryMemoryEngine {
  return new InMemoryMemoryEngine(new RealtimeMemoryClock(), new RandomMemoryIds());
}
