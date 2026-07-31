import { MorrowError } from "./errors.js";
import type { MorrowSubjectDelegation } from "./auth.js";
import type { MemoryTenantContext } from "./memory-engine.js";

export function assertSubjectAccess(
  context: MemoryTenantContext,
  subjectId: string,
  scope: string,
  now = new Date()
): void {
  if (context.subjectId === subjectId || hasActiveDelegation(context.subjectDelegations, subjectId, scope, now)) {
    return;
  }
  throw new MorrowError("TENANT_SCOPE_DENIED", "Request cannot access this resource.");
}

export function assertSubjectResourceAccess(
  context: MemoryTenantContext,
  subjectId: string,
  scope: string,
  now = new Date()
): void {
  try {
    assertSubjectAccess(context, subjectId, scope, now);
  } catch (error) {
    if (error instanceof MorrowError && error.code === "TENANT_SCOPE_DENIED") {
      throw new MorrowError("RESOURCE_NOT_FOUND", "Resource was not found.");
    }
    throw error;
  }
}

function hasActiveDelegation(
  delegations: readonly MorrowSubjectDelegation[] | undefined,
  subjectId: string,
  scope: string,
  now: Date
): boolean {
  return delegations?.some((delegation) => {
    const expiresAt = Date.parse(delegation.expiresAt);
    return delegation.subjectId === subjectId &&
      delegation.scopes.includes(scope) &&
      Number.isFinite(expiresAt) &&
      expiresAt > now.getTime();
  }) ?? false;
}
