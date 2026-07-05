import test from "node:test";
import assert from "node:assert/strict";
import {
  InMemoryPersonaStore,
  MorrowError,
  PersonaCompiler,
  type Clock,
  type IdGenerator,
  type PersonaContract,
  type TenantContext
} from "../src/index.js";

class FixedClock implements Clock {
  now(): Date {
    return new Date("2026-07-05T00:00:00.000Z");
  }
}

class SequenceIds implements IdGenerator {
  private next = 1;

  nextId(prefix: string): string {
    const value = `${prefix}_${String(this.next).padStart(4, "0")}`;
    this.next += 1;
    return value;
  }
}

const tenantA: TenantContext = {
  tenantId: "tenant_a",
  actorId: "actor_admin",
  correlationId: "corr_test"
};

const tenantB: TenantContext = {
  tenantId: "tenant_b",
  actorId: "actor_admin",
  correlationId: "corr_test_b"
};

const validContract: PersonaContract = {
  schemaVersion: "persona-contract/v1",
  name: "Morrow Guide",
  role: "memory-contract-specialist",
  traits: ["precise", "tenant-safe"],
  instructions: ["Prefer deterministic context.", "Do not infer missing consent."],
  pluginRefs: ["core-renderer"],
  policyRefs: ["default-policy"]
};

function createStore(): InMemoryPersonaStore {
  return new InMemoryPersonaStore(new FixedClock(), new SequenceIds());
}

test("AT-CONTRACT-001 published persona contract compiles deterministically", () => {
  const store = createStore();
  const compiler = new PersonaCompiler(new Set(["core-renderer"]));
  const draft = store.createDraft(tenantA, "Guide");
  const version = store.createVersion(tenantA, draft.id, validContract);
  const published = store.publishVersion(tenantA, version.id);

  const first = compiler.compile(tenantA, published, new Date("2026-07-05T01:00:00.000Z"));
  const second = compiler.compile(tenantA, published, new Date("2026-07-05T01:00:00.000Z"));

  assert.equal(first.contentHash, second.contentHash);
  assert.equal(first.provenance.sourceVersionId, published.id);
  assert.match(first.contentHash, /^[a-f0-9]{64}$/);
});

test("AT-CONTRACT-002 published versions reject mutation", () => {
  const store = createStore();
  const draft = store.createDraft(tenantA, "Guide");
  const version = store.createVersion(tenantA, draft.id, validContract);
  store.publishVersion(tenantA, version.id);

  assert.throws(
    () => store.replaceDraftContract(tenantA, version.id, { ...validContract, role: "changed" }),
    (error: unknown) => error instanceof MorrowError && error.code === "VERSION_CONFLICT"
  );
});

test("AT-CONTRACT-003 wrong tenant cannot compile another tenant version", () => {
  const store = createStore();
  const compiler = new PersonaCompiler(new Set(["core-renderer"]));
  const draft = store.createDraft(tenantA, "Guide");
  const version = store.publishVersion(tenantA, store.createVersion(tenantA, draft.id, validContract).id);

  assert.throws(
    () => compiler.compile(tenantB, version, new Date("2026-07-05T01:00:00.000Z")),
    (error: unknown) => error instanceof MorrowError && error.code === "TENANT_SCOPE_DENIED"
  );
});

test("AT-CONTRACT-004 unknown plugin fails closed", () => {
  const store = createStore();
  const compiler = new PersonaCompiler(new Set(["core-renderer"]));
  const draft = store.createDraft(tenantA, "Guide");
  const version = store.createVersion(tenantA, draft.id, {
    ...validContract,
    pluginRefs: ["missing-renderer"]
  });
  const published = store.publishVersion(tenantA, version.id);

  assert.throws(
    () => compiler.compile(tenantA, published, new Date("2026-07-05T01:00:00.000Z")),
    (error: unknown) => error instanceof MorrowError && error.code === "PLUGIN_INCOMPATIBLE"
  );
});

test("AT-AUDIT-001 create and publish write append-only audit evidence", () => {
  const store = createStore();
  const draft = store.createDraft(tenantA, "Guide");
  const version = store.createVersion(tenantA, draft.id, validContract);
  store.publishVersion(tenantA, version.id);

  assert.deepEqual(
    store.auditEvents().map((event) => event.action),
    ["persona.create", "persona-version.create", "persona-version.publish"]
  );
  assert.equal(store.auditEvents()[0]?.tenantId, tenantA.tenantId);
});
