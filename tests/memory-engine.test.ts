import test from "node:test";
import assert from "node:assert/strict";
import {
  InMemoryMemoryEngine,
  MorrowError,
  type MemoryClock,
  type MemoryIdGenerator,
  type MemoryTenantContext
} from "../src/index.js";

class FixedClock implements MemoryClock {
  private current: Date;

  constructor(current: Date = new Date("2026-07-05T00:00:00.000Z")) {
    this.current = current;
  }

  now(): Date {
    return this.current;
  }

  set(value: string): void {
    this.current = new Date(value);
  }
}

class SequenceIds implements MemoryIdGenerator {
  private next = 1;

  nextId(prefix: string): string {
    const value = `${prefix}_${String(this.next).padStart(4, "0")}`;
    this.next += 1;
    return value;
  }
}

const fullScopeContext: MemoryTenantContext = {
  tenantId: "tenant_a",
  actorId: "actor_admin",
  scopes: ["consent:write", "retention:write", "memory:write", "memory:read", "memory:delete", "memory:export"],
  correlationId: "corr_memory"
};

const otherTenantContext: MemoryTenantContext = {
  ...fullScopeContext,
  tenantId: "tenant_b",
  correlationId: "corr_other"
};

function createEngine(clock = new FixedClock()): InMemoryMemoryEngine {
  return new InMemoryMemoryEngine(clock, new SequenceIds());
}

function configurePreferenceFlow(engine: InMemoryMemoryEngine): void {
  engine.upsertRetentionRule(fullScopeContext, {
    memoryType: "preference",
    purpose: "assistant_personalization",
    ttlDays: 30,
    deletionMode: "soft_delete"
  });
  engine.registerConsent(fullScopeContext, {
    subjectId: "subject_1",
    purpose: "assistant_personalization",
    scope: ["preference"],
    expiresAt: "2026-08-05T00:00:00.000Z"
  });
}

test("AT-MORROW-001 stores and retrieves typed memory only with consent, tenant, purpose, policy, and retention", () => {
  const engine = createEngine();
  configurePreferenceFlow(engine);

  const memory = engine.registerMemory(fullScopeContext, {
    subjectId: "subject_1",
    type: "preference",
    purpose: "assistant_personalization",
    policyRef: "default-policy",
    content: "Prefers concise answers.",
    source: { kind: "user_statement", reference: "message_1" },
    confidence: 0.9,
    classification: "sensitive",
    idempotencyKey: "idem_1"
  });

  const results = engine.queryMemories(fullScopeContext, {
    subjectId: "subject_1",
    purpose: "assistant_personalization",
    policyRef: "default-policy"
  });

  assert.equal(results.length, 1);
  assert.equal(results[0]?.id, memory.id);
  assert.equal(results[0]?.contentHash.length, 64);
});

test("AT-MORROW-002 missing consent fails closed before persistence", () => {
  const engine = createEngine();
  engine.upsertRetentionRule(fullScopeContext, {
    memoryType: "preference",
    purpose: "assistant_personalization",
    ttlDays: 30,
    deletionMode: "soft_delete"
  });

  assert.throws(
    () =>
      engine.registerMemory(fullScopeContext, {
        subjectId: "subject_1",
        type: "preference",
        purpose: "assistant_personalization",
        policyRef: "default-policy",
        content: "Prefers concise answers.",
        source: { kind: "user_statement", reference: "message_1" },
        confidence: 0.9,
        classification: "sensitive",
        idempotencyKey: "idem_1"
      }),
    (error: unknown) => error instanceof MorrowError && error.code === "CONSENT_REQUIRED"
  );

  assert.equal(engine.queryMemories(fullScopeContext, {
    subjectId: "subject_1",
    purpose: "assistant_personalization",
    policyRef: "default-policy"
  }).length, 0);
});

test("TEST-TENANT-001 wrong tenant cannot retrieve or revoke memory", () => {
  const engine = createEngine();
  configurePreferenceFlow(engine);
  const memory = engine.registerMemory(fullScopeContext, {
    subjectId: "subject_1",
    type: "preference",
    purpose: "assistant_personalization",
    policyRef: "default-policy",
    content: "Prefers concise answers.",
    source: { kind: "user_statement", reference: "message_1" },
    confidence: 0.9,
    classification: "sensitive",
    idempotencyKey: "idem_1"
  });

  assert.deepEqual(
    engine.queryMemories(otherTenantContext, {
      subjectId: "subject_1",
      purpose: "assistant_personalization",
      policyRef: "default-policy"
    }),
    []
  );
  assert.throws(
    () => engine.revokeMemory(otherTenantContext, { memoryId: memory.id, reason: "user-request", idempotencyKey: "del_1" }),
    (error: unknown) => error instanceof MorrowError && error.code === "TENANT_SCOPE_DENIED"
  );
});

test("TEST-IDEMP-001 repeated idempotency key does not duplicate memory", () => {
  const engine = createEngine();
  configurePreferenceFlow(engine);
  const input = {
    subjectId: "subject_1",
    type: "preference" as const,
    purpose: "assistant_personalization",
    policyRef: "default-policy",
    content: "Prefers concise answers.",
    source: { kind: "user_statement" as const, reference: "message_1" },
    confidence: 0.9,
    classification: "sensitive" as const,
    idempotencyKey: "idem_1"
  };

  const first = engine.registerMemory(fullScopeContext, input);
  const second = engine.registerMemory(fullScopeContext, input);

  assert.equal(second.id, first.id);
  assert.equal(engine.queryMemories(fullScopeContext, {
    subjectId: "subject_1",
    purpose: "assistant_personalization",
    policyRef: "default-policy"
  }).length, 1);
});

test("TEST-RETENTION-001 expired retention removes memory from retrieval and export", () => {
  const clock = new FixedClock();
  const engine = createEngine(clock);
  configurePreferenceFlow(engine);
  engine.registerMemory(fullScopeContext, {
    subjectId: "subject_1",
    type: "preference",
    purpose: "assistant_personalization",
    policyRef: "default-policy",
    content: "Prefers concise answers.",
    source: { kind: "user_statement", reference: "message_1" },
    confidence: 0.9,
    classification: "sensitive",
    idempotencyKey: "idem_1"
  });

  clock.set("2026-08-06T00:00:00.000Z");

  assert.equal(engine.queryMemories(fullScopeContext, {
    subjectId: "subject_1",
    purpose: "assistant_personalization",
    policyRef: "default-policy"
  }).length, 0);
  assert.equal(engine.exportSubject(fullScopeContext, "subject_1").length, 0);
});

test("TEST-AUDIT-001 revoke clears content and writes append-only audit evidence", () => {
  const engine = createEngine();
  configurePreferenceFlow(engine);
  const memory = engine.registerMemory(fullScopeContext, {
    subjectId: "subject_1",
    type: "preference",
    purpose: "assistant_personalization",
    policyRef: "default-policy",
    content: "Prefers concise answers.",
    source: { kind: "user_statement", reference: "message_1" },
    confidence: 0.9,
    classification: "sensitive",
    idempotencyKey: "idem_1"
  });

  const revoked = engine.revokeMemory(fullScopeContext, {
    memoryId: memory.id,
    reason: "user-request",
    idempotencyKey: "del_1"
  });

  assert.equal(revoked.status, "revoked");
  assert.equal(revoked.content, "");
  assert.equal(engine.queryMemories(fullScopeContext, {
    subjectId: "subject_1",
    purpose: "assistant_personalization",
    policyRef: "default-policy"
  }).length, 0);
  assert.ok(engine.auditEvents().some((event) => event.action === "memory.revoke" && event.beforeHash !== event.afterHash));
});

test("AT-MORROW-003 deletion request revokes memory and is idempotent", () => {
  const engine = createEngine();
  configurePreferenceFlow(engine);
  const memory = engine.registerMemory(fullScopeContext, {
    subjectId: "subject_1",
    type: "preference",
    purpose: "assistant_personalization",
    policyRef: "default-policy",
    content: "Prefers concise answers.",
    source: { kind: "user_statement", reference: "message_1" },
    confidence: 0.9,
    classification: "sensitive",
    idempotencyKey: "idem_1"
  });

  const first = engine.createDeletionRequest(fullScopeContext, {
    memoryId: memory.id,
    reason: "subject-request",
    idempotencyKey: "delete_1"
  });
  const second = engine.createDeletionRequest(fullScopeContext, {
    memoryId: memory.id,
    reason: "subject-request",
    idempotencyKey: "delete_1"
  });

  assert.equal(second.id, first.id);
  assert.equal(engine.queryMemories(fullScopeContext, {
    subjectId: "subject_1",
    purpose: "assistant_personalization",
    policyRef: "default-policy"
  }).length, 0);
  assert.ok(engine.auditEvents().some((event) => event.action === "deletion-request.complete"));
});
