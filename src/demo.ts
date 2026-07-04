import {
  InMemoryPersonaStore,
  PersonaCompiler,
  SystemClock,
  UuidGenerator,
  type PersonaContract,
  type TenantContext
} from "./index.ts";

const context: TenantContext = {
  tenantId: "demo_tenant",
  actorId: "demo_actor",
  correlationId: "corr_demo"
};

const contract: PersonaContract = {
  schemaVersion: "persona-contract/v1",
  name: "MORROW Guide",
  role: "deterministic-contract-demo",
  traits: ["explicit", "versioned", "auditable"],
  instructions: ["Compile the same input to the same content hash."],
  pluginRefs: ["core-renderer"],
  policyRefs: ["default-policy"]
};

const store = new InMemoryPersonaStore(new SystemClock(), new UuidGenerator());
const compiler = new PersonaCompiler(new Set(["core-renderer"]));
const draft = store.createDraft(context, contract.name);
const version = store.createVersion(context, draft.id, contract);
const published = store.publishVersion(context, version.id);
const compiled = compiler.compile(context, published, new Date("2026-07-05T00:00:00.000Z"));

console.log(
  JSON.stringify(
    {
      personaId: draft.id,
      version: published.version,
      contentHash: compiled.contentHash,
      auditEvents: store.auditEvents().length
    },
    null,
    2
  )
);
