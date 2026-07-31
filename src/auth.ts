export interface MorrowSubjectDelegation {
  readonly subjectId: string;
  readonly scopes: readonly string[];
  readonly expiresAt: string;
}

export interface MorrowPrincipal {
  readonly tenantId: string;
  readonly actorId: string;
  readonly scopes: readonly string[];
  readonly subjectId?: string;
  readonly subjectDelegations?: readonly MorrowSubjectDelegation[];
}

export interface MorrowAuthenticator {
  authenticate(authorization: string | undefined): Promise<MorrowPrincipal | undefined>;
}
