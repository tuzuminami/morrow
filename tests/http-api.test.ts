import test from "node:test";
import assert from "node:assert/strict";
import { createMorrowApiServer } from "../src/index.ts";

const scopes = [
  "consent:write",
  "retention:write",
  "memory:write",
  "memory:read",
  "memory:delete",
  "memory:export"
].join(" ");

test("TEST-API-001 HTTP primary flow stores and queries consent-scoped memory", async () => {
  const server = createMorrowApiServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.notEqual(address, null);
  const port = (address as { readonly port: number }).port;

  try {
    await post(port, "/v1/retention-rules", {
      memoryType: "preference",
      purpose: "assistant_personalization",
      ttlDays: 30,
      deletionMode: "soft_delete"
    });
    await post(port, "/v1/consent-receipts", {
      subjectId: "subject_api",
      purpose: "assistant_personalization",
      scope: ["preference"],
      expiresAt: "2099-01-01T00:00:00.000Z"
    });
    const createResponse = await post(port, "/v1/memories", {
      subjectId: "subject_api",
      type: "preference",
      purpose: "assistant_personalization",
      policyRef: "default-policy",
      content: "Prefers audit-friendly APIs.",
      source: { kind: "user_statement", reference: "message_api" },
      confidence: 0.9,
      classification: "sensitive"
    }, "idem-api-1");

    assert.equal(createResponse.status, 200);

    const queryResponse = await post(port, "/v1/memories/query", {
      subjectId: "subject_api",
      purpose: "assistant_personalization",
      policyRef: "default-policy"
    });

    assert.equal(queryResponse.status, 200);
    const queryBody = queryResponse.body as {
      readonly data: { readonly memories: readonly unknown[] };
    };
    assert.equal(queryBody.data.memories.length, 1);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test("TEST-API-002 HTTP rejects missing authorization before state change", async () => {
  const server = createMorrowApiServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.notEqual(address, null);
  const port = (address as { readonly port: number }).port;

  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/retention-rules`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-tenant-id": "tenant_api"
      },
      body: JSON.stringify({
        memoryType: "preference",
        purpose: "assistant_personalization",
        ttlDays: 30,
        deletionMode: "soft_delete"
      })
    });
    const body = await response.json() as { readonly error: { readonly code: string } };

    assert.equal(response.status, 403);
    assert.equal(body.error.code, "TENANT_SCOPE_DENIED");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

async function post(port: number, path: string, body: Record<string, unknown>, idempotencyKey = "idem-test"): Promise<{
  readonly status: number;
  readonly body: unknown;
}> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: {
      authorization: "Bearer actor_api",
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
      "x-correlation-id": "corr_api",
      "x-morrow-scopes": scopes,
      "x-tenant-id": "tenant_api"
    },
    body: JSON.stringify(body)
  });

  return {
    status: response.status,
    body: await response.json()
  };
}
