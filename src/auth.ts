export interface MorrowPrincipal {
  readonly tenantId: string;
  readonly actorId: string;
  readonly scopes: readonly string[];
}

export interface MorrowAuthenticator {
  authenticate(authorization: string | undefined): Promise<MorrowPrincipal | undefined>;
}
