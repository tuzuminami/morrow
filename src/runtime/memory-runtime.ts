import {
  InMemoryMemoryEngine,
  type ConsentReceipt,
  type DeletionRequest,
  type DeletionRequestInput,
  type MemoryRecord,
  type MemoryTenantContext,
  type QueryMemoryInput,
  type RegisterConsentInput,
  type RegisterMemoryInput,
  type RetentionRule,
  type RevokeMemoryInput
} from "../memory-engine.js";

export interface MemoryRuntime {
  upsertRetentionRule(
    context: MemoryTenantContext,
    rule: Omit<RetentionRule, "tenantId">
  ): Promise<RetentionRule>;
  registerConsent(context: MemoryTenantContext, input: RegisterConsentInput): Promise<ConsentReceipt>;
  registerMemory(context: MemoryTenantContext, input: RegisterMemoryInput): Promise<MemoryRecord>;
  queryMemories(context: MemoryTenantContext, input: QueryMemoryInput): Promise<readonly MemoryRecord[]>;
  revokeMemory(context: MemoryTenantContext, input: RevokeMemoryInput): Promise<MemoryRecord>;
  createDeletionRequest(context: MemoryTenantContext, input: DeletionRequestInput): Promise<DeletionRequest>;
  exportSubject(context: MemoryTenantContext, subjectId: string): Promise<readonly Omit<MemoryRecord, "tenantId">[]>;
}

export class InMemoryMemoryRuntime implements MemoryRuntime {
  constructor(private readonly engine: InMemoryMemoryEngine) {}

  async upsertRetentionRule(
    context: MemoryTenantContext,
    rule: Omit<RetentionRule, "tenantId">
  ): Promise<RetentionRule> {
    return this.engine.upsertRetentionRule(context, rule);
  }

  async registerConsent(context: MemoryTenantContext, input: RegisterConsentInput): Promise<ConsentReceipt> {
    return this.engine.registerConsent(context, input);
  }

  async registerMemory(context: MemoryTenantContext, input: RegisterMemoryInput): Promise<MemoryRecord> {
    return this.engine.registerMemory(context, input);
  }

  async queryMemories(context: MemoryTenantContext, input: QueryMemoryInput): Promise<readonly MemoryRecord[]> {
    return this.engine.queryMemories(context, input);
  }

  async revokeMemory(context: MemoryTenantContext, input: RevokeMemoryInput): Promise<MemoryRecord> {
    return this.engine.revokeMemory(context, input);
  }

  async createDeletionRequest(context: MemoryTenantContext, input: DeletionRequestInput): Promise<DeletionRequest> {
    return this.engine.createDeletionRequest(context, input);
  }

  async exportSubject(
    context: MemoryTenantContext,
    subjectId: string
  ): Promise<readonly Omit<MemoryRecord, "tenantId">[]> {
    return this.engine.exportSubject(context, subjectId);
  }
}
