import { createHash, randomUUID } from "node:crypto";
import { MorrowError } from "./errors.js";

export type MemoryType = "episodic" | "fact" | "preference" | "relationship" | "instruction";
export type MemoryStatus = "active" | "revoked" | "expired" | "deleted";
export type DataClassification = "public" | "internal" | "sensitive";
export type DeletionMode = "soft_delete" | "hard_delete";

export interface MemoryTenantContext {
  readonly tenantId: string;
  readonly actorId: string;
  readonly scopes: readonly string[];
  readonly correlationId: string;
}

export interface MemorySource {
  readonly kind: "user_statement" | "system_observation" | "operator_import";
  readonly reference: string;
}

export interface ConsentReceipt {
  readonly id: string;
  readonly tenantId: string;
  readonly subjectId: string;
  readonly purpose: string;
  readonly scope: readonly MemoryType[];
  readonly grantedAt: string;
  readonly expiresAt: string;
  readonly revokedAt?: string;
}

export interface RetentionRule {
  readonly tenantId: string;
  readonly memoryType: MemoryType;
  readonly purpose: string;
  readonly ttlDays: number;
  readonly deletionMode: DeletionMode;
}

export interface MemoryRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly subjectId: string;
  readonly type: MemoryType;
  readonly purpose: string;
  readonly policyRef: string;
  readonly content: string;
  readonly contentHash: string;
  readonly source: MemorySource;
  readonly confidence: number;
  readonly classification: DataClassification;
  readonly retentionExpiresAt: string;
  readonly status: MemoryStatus;
  readonly createdAt: string;
  readonly createdBy: string;
  readonly updatedAt: string;
  readonly version: number;
}

export interface RegisterConsentInput {
  readonly subjectId: string;
  readonly purpose: string;
  readonly scope: readonly MemoryType[];
  readonly expiresAt: string;
}

export interface RegisterMemoryInput {
  readonly subjectId: string;
  readonly type: MemoryType;
  readonly purpose: string;
  readonly policyRef: string;
  readonly content: string;
  readonly source: MemorySource;
  readonly confidence: number;
  readonly classification: DataClassification;
  readonly idempotencyKey: string;
}

export interface QueryMemoryInput {
  readonly subjectId: string;
  readonly purpose: string;
  readonly policyRef: string;
  readonly now?: Date;
}

export interface RevokeMemoryInput {
  readonly memoryId: string;
  readonly reason: string;
  readonly idempotencyKey: string;
}

export interface MemoryAuditEvent {
  readonly id: string;
  readonly tenantId: string;
  readonly actorId: string;
  readonly correlationId: string;
  readonly action: string;
  readonly resourceId: string;
  readonly reason: string;
  readonly beforeHash?: string;
  readonly afterHash?: string;
  readonly occurredAt: string;
}

export interface MemoryClock {
  now(): Date;
}

export interface MemoryIdGenerator {
  nextId(prefix: string): string;
}

export class RealtimeMemoryClock implements MemoryClock {
  now(): Date {
    return new Date();
  }
}

export class RandomMemoryIds implements MemoryIdGenerator {
  nextId(prefix: string): string {
    return `${prefix}_${randomUUID()}`;
  }
}

export class InMemoryMemoryEngine {
  private readonly consentReceipts = new Map<string, ConsentReceipt>();
  private readonly retentionRules = new Map<string, RetentionRule>();
  private readonly memories = new Map<string, MemoryRecord>();
  private readonly idempotencyResults = new Map<string, string>();
  private readonly audits: MemoryAuditEvent[] = [];
  private readonly clock: MemoryClock;
  private readonly ids: MemoryIdGenerator;

  constructor(clock: MemoryClock, ids: MemoryIdGenerator) {
    this.clock = clock;
    this.ids = ids;
  }

  upsertRetentionRule(context: MemoryTenantContext, rule: Omit<RetentionRule, "tenantId">): RetentionRule {
    requireScope(context, "retention:write");
    if (rule.ttlDays <= 0 || !Number.isInteger(rule.ttlDays)) {
      throw new MorrowError("VALIDATION_FAILED", "Retention ttlDays must be a positive integer.");
    }
    const saved: RetentionRule = { ...rule, tenantId: context.tenantId };
    this.retentionRules.set(retentionKey(context.tenantId, rule.memoryType, rule.purpose), saved);
    this.appendAudit(context, "retention.upsert", retentionKey(context.tenantId, rule.memoryType, rule.purpose), "retention-rule-upserted");
    return saved;
  }

  registerConsent(context: MemoryTenantContext, input: RegisterConsentInput): ConsentReceipt {
    requireScope(context, "consent:write");
    assertNonEmpty(input.subjectId, "subjectId");
    assertNonEmpty(input.purpose, "purpose");
    if (input.scope.length === 0) {
      throw new MorrowError("VALIDATION_FAILED", "Consent scope must contain at least one memory type.");
    }
    const now = this.clock.now();
    const expiresAt = parseDate(input.expiresAt, "expiresAt");
    if (expiresAt <= now) {
      throw new MorrowError("VALIDATION_FAILED", "Consent expiry must be in the future.");
    }

    const receipt: ConsentReceipt = {
      id: this.ids.nextId("consent"),
      tenantId: context.tenantId,
      subjectId: input.subjectId,
      purpose: input.purpose,
      scope: [...input.scope],
      grantedAt: now.toISOString(),
      expiresAt: expiresAt.toISOString()
    };
    this.consentReceipts.set(receipt.id, receipt);
    this.appendAudit(context, "consent.register", receipt.id, "consent-registered");
    return receipt;
  }

  registerMemory(context: MemoryTenantContext, input: RegisterMemoryInput): MemoryRecord {
    requireScope(context, "memory:write");
    const existingId = this.idempotencyResults.get(idempotencyKey(context, input.idempotencyKey));
    if (existingId !== undefined) {
      const existing = this.memories.get(existingId);
      if (existing !== undefined) {
        return existing;
      }
    }

    validateMemoryInput(input);
    const now = this.clock.now();
    const consent = this.findValidConsent(context.tenantId, input.subjectId, input.purpose, input.type, now);
    if (consent === undefined) {
      throw new MorrowError("CONSENT_REQUIRED", "Consent is required before memory persistence.");
    }

    const retention = this.retentionRules.get(retentionKey(context.tenantId, input.type, input.purpose));
    if (retention === undefined) {
      throw new MorrowError("CONFIGURATION_INVALID", "Retention rule is required before memory persistence.");
    }

    const retentionExpiresAt = addDays(now, retention.ttlDays);
    const memory: MemoryRecord = {
      id: this.ids.nextId("mem"),
      tenantId: context.tenantId,
      subjectId: input.subjectId,
      type: input.type,
      purpose: input.purpose,
      policyRef: input.policyRef,
      content: input.content,
      contentHash: sha256(input.content),
      source: input.source,
      confidence: input.confidence,
      classification: input.classification,
      retentionExpiresAt: retentionExpiresAt.toISOString(),
      status: "active",
      createdAt: now.toISOString(),
      createdBy: context.actorId,
      updatedAt: now.toISOString(),
      version: 1
    };
    this.memories.set(memory.id, memory);
    this.idempotencyResults.set(idempotencyKey(context, input.idempotencyKey), memory.id);
    this.appendAudit(context, "memory.create", memory.id, "memory-created", undefined, memory.contentHash);
    return memory;
  }

  queryMemories(context: MemoryTenantContext, input: QueryMemoryInput): readonly MemoryRecord[] {
    requireScope(context, "memory:read");
    assertNonEmpty(input.subjectId, "subjectId");
    assertNonEmpty(input.purpose, "purpose");
    assertNonEmpty(input.policyRef, "policyRef");
    const now = input.now ?? this.clock.now();
    const consentTypes = new Set(
      this.activeConsents(context.tenantId, input.subjectId, input.purpose, now).flatMap((receipt) => receipt.scope)
    );

    if (consentTypes.size === 0) {
      this.appendAudit(context, "memory.query.denied", input.subjectId, "consent-missing");
      return [];
    }

    const results = [...this.memories.values()].filter((memory) => {
      return (
        memory.tenantId === context.tenantId &&
        memory.subjectId === input.subjectId &&
        memory.purpose === input.purpose &&
        memory.policyRef === input.policyRef &&
        memory.status === "active" &&
        consentTypes.has(memory.type) &&
        parseDate(memory.retentionExpiresAt, "retentionExpiresAt") > now
      );
    });
    this.appendAudit(context, "memory.query", input.subjectId, `memory-query:${results.length}`);
    return results;
  }

  revokeMemory(context: MemoryTenantContext, input: RevokeMemoryInput): MemoryRecord {
    requireScope(context, "memory:delete");
    const existingId = this.idempotencyResults.get(idempotencyKey(context, input.idempotencyKey));
    if (existingId !== undefined) {
      const existing = this.memories.get(existingId);
      if (existing !== undefined) {
        return existing;
      }
    }

    assertNonEmpty(input.reason, "reason");
    const memory = this.requireMemoryForTenant(context, input.memoryId);
    if (memory.status !== "active") {
      return memory;
    }

    const now = this.clock.now().toISOString();
    const next: MemoryRecord = {
      ...memory,
      status: "revoked",
      content: "",
      contentHash: sha256(""),
      updatedAt: now,
      version: memory.version + 1
    };
    this.memories.set(next.id, next);
    this.idempotencyResults.set(idempotencyKey(context, input.idempotencyKey), next.id);
    this.appendAudit(context, "memory.revoke", next.id, input.reason, memory.contentHash, next.contentHash);
    return next;
  }

  exportSubject(context: MemoryTenantContext, subjectId: string): readonly Omit<MemoryRecord, "tenantId">[] {
    requireScope(context, "memory:export");
    assertNonEmpty(subjectId, "subjectId");
    const now = this.clock.now();
    const records = [...this.memories.values()].filter((memory) => {
      return (
        memory.tenantId === context.tenantId &&
        memory.subjectId === subjectId &&
        memory.status === "active" &&
        parseDate(memory.retentionExpiresAt, "retentionExpiresAt") > now
      );
    });
    this.appendAudit(context, "memory.export", subjectId, `memory-export:${records.length}`);
    return records.map(({ tenantId: _tenantId, ...record }) => record);
  }

  auditEvents(): readonly MemoryAuditEvent[] {
    return [...this.audits];
  }

  private requireMemoryForTenant(context: MemoryTenantContext, memoryId: string): MemoryRecord {
    const memory = this.memories.get(memoryId);
    if (memory === undefined || memory.tenantId !== context.tenantId) {
      throw new MorrowError("TENANT_SCOPE_DENIED", "Request cannot access this resource.");
    }
    return memory;
  }

  private findValidConsent(
    tenantId: string,
    subjectId: string,
    purpose: string,
    memoryType: MemoryType,
    now: Date
  ): ConsentReceipt | undefined {
    return this.activeConsents(tenantId, subjectId, purpose, now).find((receipt) => receipt.scope.includes(memoryType));
  }

  private activeConsents(tenantId: string, subjectId: string, purpose: string, now: Date): readonly ConsentReceipt[] {
    return [...this.consentReceipts.values()].filter((receipt) => {
      return (
        receipt.tenantId === tenantId &&
        receipt.subjectId === subjectId &&
        receipt.purpose === purpose &&
        receipt.revokedAt === undefined &&
        parseDate(receipt.expiresAt, "expiresAt") > now
      );
    });
  }

  private appendAudit(
    context: MemoryTenantContext,
    action: string,
    resourceId: string,
    reason: string,
    beforeHash?: string,
    afterHash?: string
  ): void {
    const event: MemoryAuditEvent = {
      id: this.ids.nextId("audit"),
      tenantId: context.tenantId,
      actorId: context.actorId,
      correlationId: context.correlationId,
      action,
      resourceId,
      reason,
      occurredAt: this.clock.now().toISOString()
    };
    if (beforeHash !== undefined) {
      Object.assign(event, { beforeHash });
    }
    if (afterHash !== undefined) {
      Object.assign(event, { afterHash });
    }
    this.audits.push(event);
  }
}

function requireScope(context: MemoryTenantContext, scope: string): void {
  if (!context.scopes.includes(scope)) {
    throw new MorrowError("TENANT_SCOPE_DENIED", "Request cannot access this operation.");
  }
}

function validateMemoryInput(input: RegisterMemoryInput): void {
  assertNonEmpty(input.subjectId, "subjectId");
  assertNonEmpty(input.purpose, "purpose");
  assertNonEmpty(input.policyRef, "policyRef");
  assertNonEmpty(input.content, "content");
  assertNonEmpty(input.source.reference, "source.reference");
  assertNonEmpty(input.idempotencyKey, "idempotencyKey");
  if (input.confidence < 0 || input.confidence > 1) {
    throw new MorrowError("VALIDATION_FAILED", "Confidence must be between 0 and 1.");
  }
}

function assertNonEmpty(value: string, field: string): void {
  if (value.trim().length === 0) {
    throw new MorrowError("VALIDATION_FAILED", `${field} is required.`);
  }
}

function retentionKey(tenantId: string, memoryType: MemoryType, purpose: string): string {
  return `${tenantId}:${memoryType}:${purpose}`;
}

function idempotencyKey(context: MemoryTenantContext, key: string): string {
  return `${context.tenantId}:${context.actorId}:${key}`;
}

function parseDate(value: string, field: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new MorrowError("VALIDATION_FAILED", `${field} must be an ISO date.`);
  }
  return date;
}

function addDays(value: Date, days: number): Date {
  const next = new Date(value.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
