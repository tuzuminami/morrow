import { createHash } from "node:crypto";

import { MorrowError } from "../errors.js";
import { MAX_MEMORY_CONTENT_BYTES } from "../memory-engine.js";
import type {
  ConsentReceipt,
  DeletionRequest,
  DeletionRequestInput,
  MemoryAuditEvent,
  MemoryClock,
  MemoryIdGenerator,
  MemoryRecord,
  MemoryTenantContext,
  MemoryType,
  QueryMemoryInput,
  RegisterConsentInput,
  RegisterMemoryInput,
  RetentionRule,
  RevokeMemoryInput
} from "../memory-engine.js";
import type { SqlClient, SqlTransactionProvider } from "../storage/postgres-memory-store.js";
import type { MemoryRuntime } from "./memory-runtime.js";

const MAX_QUERY_RESULTS = 100;
const MAX_EXPORT_RESULTS = 100;

interface MemoryRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly subject_id: string;
  readonly type: MemoryRecord["type"];
  readonly purpose: string;
  readonly policy_ref: string;
  readonly content: string;
  readonly content_hash: string;
  readonly source: MemoryRecord["source"] | string;
  readonly confidence: number | string;
  readonly classification: MemoryRecord["classification"];
  readonly retention_expires_at: Date | string;
  readonly status: MemoryRecord["status"];
  readonly created_at: Date | string;
  readonly created_by: string;
  readonly updated_at: Date | string;
  readonly version: number;
}

interface ConsentRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly subject_id: string;
  readonly purpose: string;
  readonly scope: readonly MemoryType[] | string;
  readonly granted_at: Date | string;
  readonly expires_at: Date | string;
  readonly revoked_at: Date | string | null;
}

interface DeletionRequestRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly memory_id: string;
  readonly reason: string;
  readonly status: "completed";
  readonly created_at: Date | string;
  readonly created_by: string;
  readonly correlation_id: string;
}

interface IdempotencyRow {
  readonly operation: string;
  readonly request_hash: string;
  readonly resource_id: string;
}

export class PostgresMemoryRuntime implements MemoryRuntime {
  constructor(
    private readonly tx: SqlTransactionProvider,
    private readonly ids: MemoryIdGenerator,
    private readonly clock: MemoryClock
  ) {}

  async upsertRetentionRule(
    context: MemoryTenantContext,
    rule: Omit<RetentionRule, "tenantId">
  ): Promise<RetentionRule> {
    requireScope(context, "retention:write");
    assertNonEmpty(rule.purpose, "purpose");
    if (!Number.isInteger(rule.ttlDays) || rule.ttlDays <= 0) {
      throw new MorrowError("VALIDATION_FAILED", "Retention ttlDays must be a positive integer.");
    }
    const saved: RetentionRule = { ...rule, tenantId: context.tenantId };
    await this.tx.transaction(async (client) => {
      await client.query(
        `INSERT INTO retention_rules (tenant_id, memory_type, purpose, ttl_days, deletion_mode)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (tenant_id, memory_type, purpose)
         DO UPDATE SET ttl_days = EXCLUDED.ttl_days, deletion_mode = EXCLUDED.deletion_mode`,
        [saved.tenantId, saved.memoryType, saved.purpose, saved.ttlDays, saved.deletionMode]
      );
      await appendAudit(client, this.ids, this.clock, context, "retention.upsert", retentionResourceId(saved), "retention-rule-upserted");
    });
    return saved;
  }

  async registerConsent(context: MemoryTenantContext, input: RegisterConsentInput): Promise<ConsentReceipt> {
    requireScope(context, "consent:write");
    assertNonEmpty(input.subjectId, "subjectId");
    assertNonEmpty(input.purpose, "purpose");
    if (input.scope.length === 0 || input.scope.some((type) => !isMemoryType(type))) {
      throw new MorrowError("VALIDATION_FAILED", "Consent scope must contain supported memory types.");
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
    await this.tx.transaction(async (client) => {
      await client.query(
        `INSERT INTO consent_receipts (id, tenant_id, subject_id, purpose, scope, granted_at, expires_at, revoked_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, NULL)`,
        [receipt.id, receipt.tenantId, receipt.subjectId, receipt.purpose, JSON.stringify(receipt.scope), receipt.grantedAt, receipt.expiresAt]
      );
      await appendAudit(client, this.ids, this.clock, context, "consent.register", receipt.id, "consent-registered");
    });
    return receipt;
  }

  async registerMemory(context: MemoryTenantContext, input: RegisterMemoryInput): Promise<MemoryRecord> {
    requireScope(context, "memory:write");
    validateMemoryInput(input);
    const now = this.clock.now();
    const requestHash = fingerprint("memory.write", {
      subjectId: input.subjectId, type: input.type, purpose: input.purpose, policyRef: input.policyRef,
      content: input.content, source: input.source, confidence: input.confidence, classification: input.classification
    });
    return this.tx.transaction(async (client) => {
      const existingIdempotency = await lookupIdempotency(client, context, input.idempotencyKey);
      if (existingIdempotency !== undefined) {
        assertMatchingIdempotency(existingIdempotency, "memory.write", requestHash);
        return requireMemory(await selectMemory(client, context, existingIdempotency.resource_id));
      }
      const consent = await client.query<ConsentRow>(
        `SELECT id, tenant_id, subject_id, purpose, scope, granted_at, expires_at, revoked_at
         FROM consent_receipts
         WHERE tenant_id = $1 AND subject_id = $2 AND purpose = $3
           AND revoked_at IS NULL AND expires_at > $4 AND scope @> $5::jsonb
         ORDER BY granted_at DESC LIMIT 1`,
        [context.tenantId, input.subjectId, input.purpose, now.toISOString(), JSON.stringify([input.type])]
      );
      if (consent.rows[0] === undefined) {
        throw new MorrowError("CONSENT_REQUIRED", "Consent is required before memory persistence.");
      }
      const retention = await client.query<{ readonly ttl_days: number | string }>(
        `SELECT ttl_days FROM retention_rules
         WHERE tenant_id = $1 AND memory_type = $2 AND purpose = $3`,
        [context.tenantId, input.type, input.purpose]
      );
      const ttlDays = retention.rows[0]?.ttl_days;
      if (ttlDays === undefined) {
        throw new MorrowError("CONFIGURATION_INVALID", "Retention rule is required before memory persistence.");
      }
      const id = this.ids.nextId("mem");
      const inserted = await reserveIdempotency(client, context, input.idempotencyKey, "memory.write", requestHash, id, now);
      if (!inserted) {
        const existing = await resolveIdempotency(client, context, input.idempotencyKey, "memory.write", requestHash);
        return requireMemory(await selectMemory(client, context, existing.resource_id));
      }
      const retentionExpiresAt = addDays(now, Number(ttlDays)).toISOString();
      const memory: MemoryRecord = {
        id,
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
        retentionExpiresAt,
        status: "active",
        createdAt: now.toISOString(),
        createdBy: context.actorId,
        updatedAt: now.toISOString(),
        version: 1
      };
      await insertMemory(client, memory);
      await appendAudit(client, this.ids, this.clock, context, "memory.create", memory.id, "memory-created", undefined, memory.contentHash);
      return memory;
    });
  }

  async queryMemories(context: MemoryTenantContext, input: QueryMemoryInput): Promise<readonly MemoryRecord[]> {
    requireScope(context, "memory:read");
    assertNonEmpty(input.subjectId, "subjectId");
    assertNonEmpty(input.purpose, "purpose");
    assertNonEmpty(input.policyRef, "policyRef");
    const now = input.now ?? this.clock.now();
    return this.tx.transaction(async (client) => {
      const result = await client.query<MemoryRow>(
        `SELECT id, tenant_id, subject_id, type, purpose, policy_ref, content, content_hash, source,
                confidence, classification, retention_expires_at, status, created_at, created_by, updated_at, version
         FROM memories
         WHERE tenant_id = $1 AND subject_id = $2 AND type = $3 AND purpose = $4 AND policy_ref = $5
           AND status = 'active' AND retention_expires_at > $6
           AND EXISTS (
             SELECT 1 FROM consent_receipts
             WHERE tenant_id = $1 AND subject_id = $2 AND purpose = $4 AND revoked_at IS NULL
               AND expires_at > $6 AND scope @> $7::jsonb
           )
         ORDER BY created_at ASC
         LIMIT $8`,
        [context.tenantId, input.subjectId, input.type, input.purpose, input.policyRef, now.toISOString(), JSON.stringify([input.type]), MAX_QUERY_RESULTS + 1]
      );
      if (result.rows.length > MAX_QUERY_RESULTS) {
        throw new MorrowError("PAYLOAD_TOO_LARGE", "Query result exceeds the V1 limit of 100 memories.");
      }
      const memories = result.rows.map(memoryFromRow);
      await appendAudit(client, this.ids, this.clock, context, "memory.query", input.subjectId, `memory-query:${memories.length}`);
      return memories;
    });
  }

  async revokeMemory(context: MemoryTenantContext, input: RevokeMemoryInput): Promise<MemoryRecord> {
    requireScope(context, "memory:delete");
    assertNonEmpty(input.memoryId, "memoryId");
    assertNonEmpty(input.reason, "reason");
    assertNonEmpty(input.idempotencyKey, "idempotencyKey");
    const now = this.clock.now();
    const requestHash = fingerprint("memory.revoke", { memoryId: input.memoryId, reason: input.reason });
    return this.tx.transaction(async (client) => {
      const current = requireMemory(await selectMemory(client, context, input.memoryId, true));
      const inserted = await reserveIdempotency(client, context, input.idempotencyKey, "memory.revoke", requestHash, current.id, now);
      if (!inserted) {
        const existing = await resolveIdempotency(client, context, input.idempotencyKey, "memory.revoke", requestHash);
        return requireMemory(await selectMemory(client, context, existing.resource_id));
      }
      if (current.status !== "active") {
        return current;
      }
      const updatedAt = now.toISOString();
      const nextHash = sha256("");
      await client.query(
        `UPDATE memories SET status = 'revoked', content = '', content_hash = $3, updated_at = $4, version = version + 1
         WHERE tenant_id = $1 AND id = $2`,
        [context.tenantId, current.id, nextHash, updatedAt]
      );
      const revoked = requireMemory(await selectMemory(client, context, current.id));
      await appendAudit(client, this.ids, this.clock, context, "memory.revoke", revoked.id, input.reason, current.contentHash, nextHash);
      return revoked;
    });
  }

  async createDeletionRequest(context: MemoryTenantContext, input: DeletionRequestInput): Promise<DeletionRequest> {
    requireScope(context, "memory:delete");
    assertNonEmpty(input.memoryId, "memoryId");
    assertNonEmpty(input.reason, "reason");
    assertNonEmpty(input.idempotencyKey, "idempotencyKey");
    const now = this.clock.now();
    const requestHash = fingerprint("deletion-request.create", { memoryId: input.memoryId, reason: input.reason });
    return this.tx.transaction(async (client) => {
      const existingIdempotency = await lookupIdempotency(client, context, input.idempotencyKey);
      if (existingIdempotency !== undefined) {
        assertMatchingIdempotency(existingIdempotency, "deletion-request.create", requestHash);
        return requireDeletionRequest(await selectDeletionRequest(client, context, existingIdempotency.resource_id));
      }
      const current = requireMemory(await selectMemory(client, context, input.memoryId, true));
      const id = this.ids.nextId("del");
      const inserted = await reserveIdempotency(client, context, input.idempotencyKey, "deletion-request.create", requestHash, id, now);
      if (!inserted) {
        const existing = await resolveIdempotency(client, context, input.idempotencyKey, "deletion-request.create", requestHash);
        return requireDeletionRequest(await selectDeletionRequest(client, context, existing.resource_id));
      }
      const retention = await client.query<{ readonly deletion_mode: "soft_delete" | "hard_delete" }>(
        `SELECT deletion_mode FROM retention_rules
         WHERE tenant_id = $1 AND memory_type = $2 AND purpose = $3`,
        [context.tenantId, current.type, current.purpose]
      );
      const deletionMode = retention.rows[0]?.deletion_mode;
      if (deletionMode === undefined) {
        throw new MorrowError("CONFIGURATION_INVALID", "Retention rule is required before deletion.");
      }
      const beforeHash = current.contentHash;
      if (deletionMode === "hard_delete") {
        await client.query("DELETE FROM memories WHERE tenant_id = $1 AND id = $2", [context.tenantId, current.id]);
        await appendAudit(client, this.ids, this.clock, context, "memory.hard-delete", current.id, input.reason, beforeHash);
      } else if (current.status === "active") {
          const clearedHash = sha256("");
          await client.query(
            `UPDATE memories SET status = 'revoked', content = '', content_hash = $3, updated_at = $4, version = version + 1
             WHERE tenant_id = $1 AND id = $2`,
            [context.tenantId, current.id, clearedHash, now.toISOString()]
          );
          await appendAudit(client, this.ids, this.clock, context, "memory.revoke", current.id, input.reason, beforeHash, clearedHash);
      }
      const request: DeletionRequest = {
        id,
        tenantId: context.tenantId,
        memoryId: current.id,
        reason: input.reason,
        status: "completed",
        createdAt: now.toISOString(),
        createdBy: context.actorId,
        correlationId: context.correlationId
      };
      await client.query(
        `INSERT INTO deletion_requests (id, tenant_id, memory_id, reason, status, created_at, created_by, correlation_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [request.id, request.tenantId, request.memoryId, request.reason, request.status, request.createdAt, request.createdBy, request.correlationId]
      );
      await appendAudit(client, this.ids, this.clock, context, "deletion-request.complete", request.id, input.reason, beforeHash);
      return request;
    });
  }

  async exportSubject(context: MemoryTenantContext, subjectId: string): Promise<readonly Omit<MemoryRecord, "tenantId">[]> {
    requireScope(context, "memory:export");
    assertNonEmpty(subjectId, "subjectId");
    const now = this.clock.now();
    return this.tx.transaction(async (client) => {
      const result = await client.query<MemoryRow>(
        `SELECT id, tenant_id, subject_id, type, purpose, policy_ref, content, content_hash, source,
                confidence, classification, retention_expires_at, status, created_at, created_by, updated_at, version
         FROM memories
         WHERE tenant_id = $1 AND subject_id = $2 AND status = 'active' AND retention_expires_at > $3
         ORDER BY created_at ASC
         LIMIT $4`,
        [context.tenantId, subjectId, now.toISOString(), MAX_EXPORT_RESULTS + 1]
      );
      if (result.rows.length > MAX_EXPORT_RESULTS) {
        throw new MorrowError("PAYLOAD_TOO_LARGE", "Subject export exceeds the V1 limit of 1000 memories.");
      }
      const records = result.rows.map(memoryFromRow).map(({ tenantId: _tenantId, ...record }) => record);
      await appendAudit(client, this.ids, this.clock, context, "memory.export", subjectId, `memory-export:${records.length}`);
      return records;
    });
  }
}

async function reserveIdempotency(
  client: SqlClient,
  context: MemoryTenantContext,
  key: string,
  operation: string,
  requestHash: string,
  resourceId: string,
  now: Date
): Promise<boolean> {
  const result = await client.query<{ readonly resource_id: string }>(
    `INSERT INTO idempotency_keys (tenant_id, actor_id, idempotency_key, operation, request_hash, resource_id, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (tenant_id, actor_id, idempotency_key) DO NOTHING
     RETURNING resource_id`,
    [context.tenantId, context.actorId, key, operation, requestHash, resourceId, now.toISOString()]
  );
  return result.rows[0] !== undefined;
}

async function resolveIdempotency(
  client: SqlClient,
  context: MemoryTenantContext,
  key: string,
  operation: string,
  requestHash: string
): Promise<IdempotencyRow> {
  const existing = await lookupIdempotency(client, context, key);
  if (existing === undefined) {
    throw new MorrowError("VERSION_CONFLICT", "Idempotency key conflicts with a previous request.");
  }
  assertMatchingIdempotency(existing, operation, requestHash);
  return existing;
}

async function lookupIdempotency(
  client: SqlClient,
  context: MemoryTenantContext,
  key: string
): Promise<IdempotencyRow | undefined> {
  const result = await client.query<IdempotencyRow>(
    `SELECT operation, request_hash, resource_id FROM idempotency_keys
     WHERE tenant_id = $1 AND actor_id = $2 AND idempotency_key = $3`,
    [context.tenantId, context.actorId, key]
  );
  return result.rows[0];
}

function assertMatchingIdempotency(existing: IdempotencyRow, operation: string, requestHash: string): void {
  if (existing.operation !== operation || existing.request_hash !== requestHash) {
    throw new MorrowError("VERSION_CONFLICT", "Idempotency key conflicts with a previous request.");
  }
}

async function selectMemory(client: SqlClient, context: MemoryTenantContext, id: string, forUpdate = false): Promise<MemoryRecord | undefined> {
  const result = await client.query<MemoryRow>(
    `SELECT id, tenant_id, subject_id, type, purpose, policy_ref, content, content_hash, source,
            confidence, classification, retention_expires_at, status, created_at, created_by, updated_at, version
     FROM memories WHERE tenant_id = $1 AND id = $2${forUpdate ? " FOR UPDATE" : ""}`,
    [context.tenantId, id]
  );
  const row = result.rows[0];
  return row === undefined ? undefined : memoryFromRow(row);
}

async function selectDeletionRequest(client: SqlClient, context: MemoryTenantContext, id: string): Promise<DeletionRequest | undefined> {
  const result = await client.query<DeletionRequestRow>(
    `SELECT id, tenant_id, memory_id, reason, status, created_at, created_by, correlation_id
     FROM deletion_requests WHERE tenant_id = $1 AND id = $2`,
    [context.tenantId, id]
  );
  const row = result.rows[0];
  return row === undefined ? undefined : deletionRequestFromRow(row);
}

async function insertMemory(client: SqlClient, memory: MemoryRecord): Promise<void> {
  await client.query(
    `INSERT INTO memories (
      id, tenant_id, subject_id, type, purpose, policy_ref, content, content_hash, source, confidence,
      classification, retention_expires_at, status, created_at, created_by, updated_at, version
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13, $14, $15, $16, $17)`,
    [
      memory.id, memory.tenantId, memory.subjectId, memory.type, memory.purpose, memory.policyRef,
      memory.content, memory.contentHash, JSON.stringify(memory.source), memory.confidence, memory.classification,
      memory.retentionExpiresAt, memory.status, memory.createdAt, memory.createdBy, memory.updatedAt, memory.version
    ]
  );
}

async function appendAudit(
  client: SqlClient,
  ids: MemoryIdGenerator,
  clock: MemoryClock,
  context: MemoryTenantContext,
  action: string,
  resourceId: string,
  reason: string,
  beforeHash?: string,
  afterHash?: string
): Promise<void> {
  const event: MemoryAuditEvent = {
    id: ids.nextId("audit"), tenantId: context.tenantId, actorId: context.actorId,
    correlationId: context.correlationId, action, resourceId, reason,
    ...(beforeHash === undefined ? {} : { beforeHash }),
    ...(afterHash === undefined ? {} : { afterHash }),
    occurredAt: clock.now().toISOString()
  };
  await client.query(
    `INSERT INTO audit_events (id, tenant_id, actor_id, correlation_id, action, resource_id, reason, before_hash, after_hash, occurred_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [event.id, event.tenantId, event.actorId, event.correlationId, event.action, event.resourceId, event.reason,
      event.beforeHash ?? null, event.afterHash ?? null, event.occurredAt]
  );
}

function memoryFromRow(row: MemoryRow): MemoryRecord {
  return {
    id: row.id, tenantId: row.tenant_id, subjectId: row.subject_id, type: row.type, purpose: row.purpose,
    policyRef: row.policy_ref, content: row.content, contentHash: row.content_hash,
    source: typeof row.source === "string" ? JSON.parse(row.source) as MemoryRecord["source"] : row.source,
    confidence: typeof row.confidence === "string" ? Number.parseFloat(row.confidence) : row.confidence,
    classification: row.classification, retentionExpiresAt: toIso(row.retention_expires_at), status: row.status,
    createdAt: toIso(row.created_at), createdBy: row.created_by, updatedAt: toIso(row.updated_at), version: row.version
  };
}

function deletionRequestFromRow(row: DeletionRequestRow): DeletionRequest {
  return {
    id: row.id, tenantId: row.tenant_id, memoryId: row.memory_id, reason: row.reason, status: row.status,
    createdAt: toIso(row.created_at), createdBy: row.created_by, correlationId: row.correlation_id
  };
}

function requireMemory(memory: MemoryRecord | undefined): MemoryRecord {
  if (memory === undefined) {
    throw new MorrowError("TENANT_SCOPE_DENIED", "Request cannot access this resource.");
  }
  return memory;
}

function requireDeletionRequest(request: DeletionRequest | undefined): DeletionRequest {
  if (request === undefined) {
    throw new MorrowError("VERSION_CONFLICT", "Idempotency key points to a missing deletion request.");
  }
  return request;
}

function requireScope(context: MemoryTenantContext, scope: string): void {
  if (!context.scopes.includes(scope)) {
    throw new MorrowError("TENANT_SCOPE_DENIED", `Missing required scope: ${scope}.`);
  }
}

function validateMemoryInput(input: RegisterMemoryInput): void {
  assertNonEmpty(input.subjectId, "subjectId");
  assertNonEmpty(input.purpose, "purpose");
  assertNonEmpty(input.policyRef, "policyRef");
  assertNonEmpty(input.content, "content");
  assertNonEmpty(input.source.reference, "source.reference");
  assertNonEmpty(input.idempotencyKey, "idempotencyKey");
  assertByteLength(input.content, MAX_MEMORY_CONTENT_BYTES, "content");
  assertByteLength(input.source.reference, 2_048, "source.reference");
  assertByteLength(input.policyRef, 512, "policyRef");
  assertByteLength(input.purpose, 256, "purpose");
  assertByteLength(input.subjectId, 256, "subjectId");
  assertByteLength(input.idempotencyKey, 256, "idempotencyKey");
  if (!isMemoryType(input.type) || !["user_statement", "system_observation", "operator_import"].includes(input.source.kind)) {
    throw new MorrowError("VALIDATION_FAILED", "Unsupported memory type or source kind.");
  }
  if (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1) {
    throw new MorrowError("VALIDATION_FAILED", "confidence must be between 0 and 1.");
  }
  if (!["public", "internal", "sensitive"].includes(input.classification)) {
    throw new MorrowError("VALIDATION_FAILED", "Unsupported data classification.");
  }
}

function assertByteLength(value: string, maximum: number, field: string): void {
  if (Buffer.byteLength(value, "utf8") > maximum) {
    throw new MorrowError("PAYLOAD_TOO_LARGE", `${field} exceeds the ${maximum}-byte limit.`);
  }
}

function assertNonEmpty(value: string, field: string): void {
  if (value.trim().length === 0) {
    throw new MorrowError("VALIDATION_FAILED", `${field} must be non-empty.`);
  }
}

function parseDate(value: string, field: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new MorrowError("VALIDATION_FAILED", `${field} must be an ISO date.`);
  }
  return parsed;
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function isMemoryType(value: string): value is MemoryType {
  return ["episodic", "fact", "preference", "relationship", "instruction"].includes(value);
}

function retentionResourceId(rule: RetentionRule): string {
  return `${rule.tenantId}:${rule.memoryType}:${rule.purpose}`;
}

function fingerprint(operation: string, value: unknown): string {
  return sha256(JSON.stringify({ operation, value }));
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
