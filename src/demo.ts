import { InMemoryMemoryEngine, RandomMemoryIds, RealtimeMemoryClock, type MemoryTenantContext } from "./index.js";

const context: MemoryTenantContext = {
  tenantId: "demo_tenant",
  actorId: "demo_actor",
  scopes: ["consent:write", "retention:write", "memory:write", "memory:read", "memory:export"],
  correlationId: "corr_demo"
};

const engine = new InMemoryMemoryEngine(new RealtimeMemoryClock(), new RandomMemoryIds());

engine.upsertRetentionRule(context, {
  memoryType: "preference",
  purpose: "assistant_personalization",
  ttlDays: 30,
  deletionMode: "soft_delete"
});

engine.registerConsent(context, {
  subjectId: "subject_demo",
  purpose: "assistant_personalization",
  scope: ["preference"],
  expiresAt: "2099-01-01T00:00:00.000Z"
});

const memory = engine.registerMemory(context, {
  subjectId: "subject_demo",
  type: "preference",
  purpose: "assistant_personalization",
  policyRef: "default-policy",
  content: "Prefers concise implementation notes.",
  source: { kind: "user_statement", reference: "demo-message-1" },
  confidence: 0.9,
  classification: "sensitive",
  idempotencyKey: "demo-idempotency-key"
});

const results = engine.queryMemories(context, {
  subjectId: "subject_demo",
  purpose: "assistant_personalization",
  policyRef: "default-policy"
});

console.log(
  JSON.stringify(
    {
      storedMemoryId: memory.id,
      returnedCount: results.length,
      contentHash: memory.contentHash,
      auditEvents: engine.auditEvents().length
    },
    null,
    2
  )
);
