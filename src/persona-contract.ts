import { createHash, randomUUID } from "node:crypto";
import { canonicalJson, type JsonObject, type JsonValue } from "./canonical-json.ts";
import { MorrowError } from "./errors.ts";

export const compilerVersion = "morrow-persona-compiler/0.1.0";

export type VersionStatus = "draft" | "published";

export interface TenantContext {
  readonly tenantId: string;
  readonly actorId: string;
  readonly correlationId: string;
}

export interface PersonaDraft {
  readonly id: string;
  readonly tenantId: string;
  readonly name: string;
}

export interface PersonaContract {
  readonly schemaVersion: "persona-contract/v1";
  readonly name: string;
  readonly role: string;
  readonly traits: readonly string[];
  readonly instructions: readonly string[];
  readonly pluginRefs?: readonly string[];
  readonly policyRefs?: readonly string[];
  readonly metadata?: JsonObject;
}

export interface PersonaVersion {
  readonly id: string;
  readonly tenantId: string;
  readonly personaId: string;
  readonly version: number;
  readonly status: VersionStatus;
  readonly contract: PersonaContract;
}

export interface CompiledBundle {
  readonly schemaVersion: "compiled-bundle/v1";
  readonly compilerVersion: string;
  readonly tenantId: string;
  readonly personaId: string;
  readonly version: number;
  readonly contentHash: string;
  readonly canonicalContract: string;
  readonly context: readonly string[];
  readonly provenance: {
    readonly sourceVersionId: string;
    readonly contractHash: string;
    readonly compiledAt: string;
  };
}

export interface AuditEvent {
  readonly id: string;
  readonly tenantId: string;
  readonly actorId: string;
  readonly correlationId: string;
  readonly action: string;
  readonly resourceId: string;
  readonly reason: string;
  readonly occurredAt: string;
}

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  nextId(prefix: string): string;
}

export interface PersonaStore {
  createDraft(context: TenantContext, name: string): PersonaDraft;
  createVersion(context: TenantContext, personaId: string, contract: PersonaContract): PersonaVersion;
  publishVersion(context: TenantContext, versionId: string): PersonaVersion;
  getVersion(context: TenantContext, versionId: string): PersonaVersion;
  replaceDraftContract(context: TenantContext, versionId: string, contract: PersonaContract): PersonaVersion;
  auditEvents(): readonly AuditEvent[];
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

export class UuidGenerator implements IdGenerator {
  nextId(prefix: string): string {
    return `${prefix}_${randomUUID()}`;
  }
}

export class InMemoryPersonaStore implements PersonaStore {
  private readonly drafts = new Map<string, PersonaDraft>();
  private readonly versions = new Map<string, PersonaVersion>();
  private readonly versionCounters = new Map<string, number>();
  private readonly audits: AuditEvent[] = [];
  private readonly clock: Clock;
  private readonly ids: IdGenerator;

  constructor(clock: Clock, ids: IdGenerator) {
    this.clock = clock;
    this.ids = ids;
  }

  createDraft(context: TenantContext, name: string): PersonaDraft {
    assertNonEmpty(name, "name");
    const draft: PersonaDraft = {
      id: this.ids.nextId("persona"),
      tenantId: context.tenantId,
      name
    };
    this.drafts.set(draft.id, draft);
    this.appendAudit(context, "persona.create", draft.id, "draft-created");
    return draft;
  }

  createVersion(context: TenantContext, personaId: string, contract: PersonaContract): PersonaVersion {
    const persona = this.requirePersona(context, personaId);
    validatePersonaContract(contract);
    const nextVersion = (this.versionCounters.get(persona.id) ?? 0) + 1;
    this.versionCounters.set(persona.id, nextVersion);

    const version: PersonaVersion = {
      id: this.ids.nextId("version"),
      tenantId: context.tenantId,
      personaId: persona.id,
      version: nextVersion,
      status: "draft",
      contract
    };
    this.versions.set(version.id, version);
    this.appendAudit(context, "persona-version.create", version.id, "version-draft-created");
    return version;
  }

  publishVersion(context: TenantContext, versionId: string): PersonaVersion {
    const version = this.getVersion(context, versionId);
    if (version.status === "published") {
      return version;
    }

    const published: PersonaVersion = { ...version, status: "published" };
    this.versions.set(version.id, published);
    this.appendAudit(context, "persona-version.publish", version.id, "version-published");
    return published;
  }

  getVersion(context: TenantContext, versionId: string): PersonaVersion {
    const version = this.versions.get(versionId);
    if (version === undefined) {
      throw new MorrowError("RESOURCE_NOT_FOUND", "Persona version was not found.");
    }
    if (version.tenantId !== context.tenantId) {
      throw new MorrowError("TENANT_SCOPE_DENIED", "Request cannot access this resource.");
    }
    return version;
  }

  replaceDraftContract(context: TenantContext, versionId: string, contract: PersonaContract): PersonaVersion {
    const version = this.getVersion(context, versionId);
    if (version.status === "published") {
      throw new MorrowError("VERSION_CONFLICT", "Published versions are immutable.");
    }
    validatePersonaContract(contract);
    const next: PersonaVersion = { ...version, contract };
    this.versions.set(version.id, next);
    this.appendAudit(context, "persona-version.update", version.id, "draft-contract-replaced");
    return next;
  }

  auditEvents(): readonly AuditEvent[] {
    return [...this.audits];
  }

  private requirePersona(context: TenantContext, personaId: string): PersonaDraft {
    const persona = this.drafts.get(personaId);
    if (persona === undefined) {
      throw new MorrowError("RESOURCE_NOT_FOUND", "Persona was not found.");
    }
    if (persona.tenantId !== context.tenantId) {
      throw new MorrowError("TENANT_SCOPE_DENIED", "Request cannot access this resource.");
    }
    return persona;
  }

  private appendAudit(context: TenantContext, action: string, resourceId: string, reason: string): void {
    this.audits.push({
      id: this.ids.nextId("audit"),
      tenantId: context.tenantId,
      actorId: context.actorId,
      correlationId: context.correlationId,
      action,
      resourceId,
      reason,
      occurredAt: this.clock.now().toISOString()
    });
  }
}

export class PersonaCompiler {
  private readonly allowedPlugins: ReadonlySet<string>;

  constructor(allowedPlugins: ReadonlySet<string>) {
    this.allowedPlugins = allowedPlugins;
  }

  compile(context: TenantContext, version: PersonaVersion, compiledAt: Date): CompiledBundle {
    if (version.tenantId !== context.tenantId) {
      throw new MorrowError("TENANT_SCOPE_DENIED", "Request cannot access this resource.");
    }
    if (version.status !== "published") {
      throw new MorrowError("VERSION_CONFLICT", "Only published versions can be compiled.");
    }

    for (const pluginRef of version.contract.pluginRefs ?? []) {
      if (!this.allowedPlugins.has(pluginRef)) {
        throw new MorrowError("PLUGIN_INCOMPATIBLE", "Referenced plugin is not available.");
      }
    }

    const canonicalContract = canonicalJson(version.contract as unknown as JsonValue);
    const contractHash = sha256(canonicalContract);
    const contextLines = [
      `name:${version.contract.name}`,
      `role:${version.contract.role}`,
      ...version.contract.traits.map((trait) => `trait:${trait}`),
      ...version.contract.instructions.map((instruction) => `instruction:${instruction}`),
      ...(version.contract.policyRefs ?? []).map((policyRef) => `policy:${policyRef}`)
    ];
    const bundleInput = canonicalJson({
      compilerVersion,
      contractHash,
      context: contextLines
    });

    return {
      schemaVersion: "compiled-bundle/v1",
      compilerVersion,
      tenantId: version.tenantId,
      personaId: version.personaId,
      version: version.version,
      contentHash: sha256(bundleInput),
      canonicalContract,
      context: contextLines,
      provenance: {
        sourceVersionId: version.id,
        contractHash,
        compiledAt: compiledAt.toISOString()
      }
    };
  }
}

export function validatePersonaContract(contract: PersonaContract): void {
  if (contract.schemaVersion !== "persona-contract/v1") {
    throw new MorrowError("VALIDATION_FAILED", "Unsupported contract schema version.");
  }

  assertNonEmpty(contract.name, "name");
  assertNonEmpty(contract.role, "role");
  assertNonEmptyArray(contract.traits, "traits");
  assertNonEmptyArray(contract.instructions, "instructions");

  for (const value of [
    ...(contract.pluginRefs ?? []),
    ...(contract.policyRefs ?? [])
  ]) {
    assertNonEmpty(value, "reference");
  }
}

function assertNonEmpty(value: string, field: string): void {
  if (value.trim().length === 0) {
    throw new MorrowError("VALIDATION_FAILED", `${field} is required.`);
  }
}

function assertNonEmptyArray(values: readonly string[], field: string): void {
  if (values.length === 0) {
    throw new MorrowError("VALIDATION_FAILED", `${field} must contain at least one item.`);
  }
  for (const value of values) {
    assertNonEmpty(value, field);
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
