import { createHash } from "node:crypto";
import { MorrowError } from "../errors.js";
import { assertSubjectAccess } from "../subject-authorization.js";
import type {
  MemoryAuditEvent,
  MemoryRecord,
  MemoryTenantContext,
  RegisterMemoryInput
} from "../index.js";

export interface SqlQueryResult<Row> {
  readonly rows: readonly Row[];
}

export interface SqlClient {
  query<Row = unknown>(sql: string, values?: readonly unknown[]): Promise<SqlQueryResult<Row>>;
}

export interface SqlPoolClient extends SqlClient {
  release(): void;
}

export interface SqlPool {
  connect(): Promise<SqlPoolClient>;
}

export interface SqlTransactionProvider {
  transaction<T>(operation: (client: SqlClient) => Promise<T>): Promise<T>;
}

export interface PostgresMemoryStoreIds {
  nextId(prefix: string): string;
}

export interface PostgresMemoryStoreClock {
  now(): Date;
}

export class PooledSqlTransactionProvider implements SqlTransactionProvider {
  constructor(private readonly pool: SqlPool) {}

  async transaction<T>(operation: (client: SqlClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

export class PostgresMemoryStore {
  constructor(
    private readonly tx: SqlTransactionProvider,
    private readonly ids: PostgresMemoryStoreIds,
    private readonly clock: PostgresMemoryStoreClock
  ) {}

  async insertMemoryWithAudit(context: MemoryTenantContext, input: RegisterMemoryInput, retentionExpiresAt: Date): Promise<MemoryRecord> {
    assertSubjectAccess(context, input.subjectId, "memory:write", this.clock.now());
    return this.tx.transaction(async (client) => {
      const now = this.clock.now().toISOString();
      const requestHash = memoryWriteRequestHash(input);
      const existingIdempotency = await client.query<IdempotencyRow>(
        `SELECT resource_id, request_hash, subject_id
        FROM idempotency_keys
        WHERE tenant_id = $1
          AND actor_id = $2
          AND idempotency_key = $3`,
        [context.tenantId, context.actorId, input.idempotencyKey]
      );
      const existing = existingIdempotency.rows[0];
      if (existing !== undefined) {
        if (existing.subject_id === null || existing.subject_id !== input.subjectId || existing.request_hash !== requestHash) {
          throw new MorrowError("VERSION_CONFLICT", "Idempotency key conflicts with a previous request.");
        }
        const memory = await this.selectMemoryById(client, context, existing.resource_id);
        if (memory === undefined) {
          throw new MorrowError("VERSION_CONFLICT", "Idempotency key points to a missing memory.");
        }
        return memory;
      }

      const contentHash = await sha256Hex(input.content);
      const memory: MemoryRecord = {
        id: this.ids.nextId("mem"),
        tenantId: context.tenantId,
        subjectId: input.subjectId,
        type: input.type,
        purpose: input.purpose,
        policyRef: input.policyRef,
        content: input.content,
        contentHash,
        source: input.source,
        confidence: input.confidence,
        classification: input.classification,
        retentionExpiresAt: retentionExpiresAt.toISOString(),
        status: "active",
        createdAt: now,
        createdBy: context.actorId,
        updatedAt: now,
        version: 1
      };

      await client.query(
        `INSERT INTO memories (
          id, tenant_id, subject_id, type, purpose, policy_ref, content, content_hash,
          source, confidence, classification, retention_expires_at, status,
          created_at, created_by, updated_at, version
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8,
          $9::jsonb, $10, $11, $12, $13,
          $14, $15, $16, $17
        )`,
        [
          memory.id,
          memory.tenantId,
          memory.subjectId,
          memory.type,
          memory.purpose,
          memory.policyRef,
          memory.content,
          memory.contentHash,
          JSON.stringify(memory.source),
          memory.confidence,
          memory.classification,
          memory.retentionExpiresAt,
          memory.status,
          memory.createdAt,
          memory.createdBy,
          memory.updatedAt,
          memory.version
        ]
      );

      await client.query(
        `INSERT INTO idempotency_keys (
          tenant_id, actor_id, idempotency_key, subject_id, operation, request_hash, resource_id, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          context.tenantId,
          context.actorId,
          input.idempotencyKey,
          input.subjectId,
          "memory.write",
          requestHash,
          memory.id,
          now
        ]
      );

      await this.appendAudit(client, context, {
        id: this.ids.nextId("audit"),
        tenantId: context.tenantId,
        actorId: context.actorId,
        correlationId: context.correlationId,
        action: "memory.create",
        resourceId: memory.id,
        reason: "memory-created",
        afterHash: contentHash,
        occurredAt: now
      });

      return memory;
    });
  }

  async queryActiveMemories(
    context: MemoryTenantContext,
    subjectId: string,
    type: MemoryRecord["type"],
    purpose: string,
    policyRef: string,
    now: Date
  ): Promise<readonly MemoryRecord[]> {
    assertSubjectAccess(context, subjectId, "memory:read", now);
    const result = await this.tx.transaction((client) =>
      client.query<MemoryRow>(
        `SELECT
          id, tenant_id, subject_id, type, purpose, policy_ref, content, content_hash,
          source, confidence, classification, retention_expires_at, status,
          created_at, created_by, updated_at, version
        FROM memories
        WHERE tenant_id = $1
          AND subject_id = $2
          AND type = $3
          AND purpose = $4
          AND policy_ref = $5
          AND status = 'active'
          AND retention_expires_at > $6
        ORDER BY created_at ASC`,
        [context.tenantId, subjectId, type, purpose, policyRef, now.toISOString()]
      )
    );

    return result.rows.map(memoryFromRow);
  }

  private async selectMemoryById(client: SqlClient, context: MemoryTenantContext, memoryId: string): Promise<MemoryRecord | undefined> {
    const result = await client.query<MemoryRow>(
      `SELECT
        id, tenant_id, subject_id, type, purpose, policy_ref, content, content_hash,
        source, confidence, classification, retention_expires_at, status,
        created_at, created_by, updated_at, version
      FROM memories
      WHERE tenant_id = $1
        AND id = $2`,
      [context.tenantId, memoryId]
    );
    const row = result.rows[0];
    return row === undefined ? undefined : memoryFromRow(row);
  }

  private async appendAudit(client: SqlClient, context: MemoryTenantContext, event: MemoryAuditEvent): Promise<void> {
    await client.query(
      `INSERT INTO audit_events (
        id, tenant_id, actor_id, correlation_id, action, resource_id, reason,
        before_hash, after_hash, occurred_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        event.id,
        context.tenantId,
        event.actorId,
        event.correlationId,
        event.action,
        event.resourceId,
        event.reason,
        event.beforeHash ?? null,
        event.afterHash ?? null,
        event.occurredAt
      ]
    );
  }
}

export class ScriptedTransactionProvider implements SqlTransactionProvider {
  readonly queries: Array<{ readonly sql: string; readonly values: readonly unknown[] }> = [];

  constructor(private readonly results: Array<SqlQueryResult<unknown>> = []) {}

  async transaction<T>(operation: (client: SqlClient) => Promise<T>): Promise<T> {
    const client: SqlClient = {
      query: async <Row = unknown>(sql: string, values: readonly unknown[] = []): Promise<SqlQueryResult<Row>> => {
        this.queries.push({ sql, values });
        const result = this.results.shift();
        return (result ?? { rows: [] }) as SqlQueryResult<Row>;
      }
    };

    return operation(client);
  }
}

interface IdempotencyRow {
  readonly resource_id: string;
  readonly request_hash: string;
  readonly subject_id: string | null;
}

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

function memoryFromRow(row: MemoryRow): MemoryRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    subjectId: row.subject_id,
    type: row.type,
    purpose: row.purpose,
    policyRef: row.policy_ref,
    content: row.content,
    contentHash: row.content_hash,
    source: typeof row.source === "string" ? JSON.parse(row.source) as MemoryRecord["source"] : row.source,
    confidence: typeof row.confidence === "string" ? Number.parseFloat(row.confidence) : row.confidence,
    classification: row.classification,
    retentionExpiresAt: toIso(row.retention_expires_at),
    status: row.status,
    createdAt: toIso(row.created_at),
    createdBy: row.created_by,
    updatedAt: toIso(row.updated_at),
    version: row.version
  };
}

async function sha256Hex(value: string): Promise<string> {
  return createHash("sha256").update(value).digest("hex");
}

function memoryWriteRequestHash(input: RegisterMemoryInput): string {
  return createHash("sha256").update(JSON.stringify({
    operation: "memory.write",
    subjectId: input.subjectId,
    type: input.type,
    purpose: input.purpose,
    policyRef: input.policyRef,
    content: input.content,
    sourceKind: input.source.kind,
    sourceReference: input.source.reference,
    confidence: input.confidence,
    classification: input.classification
  })).digest("hex");
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
