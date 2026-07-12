export type ErrorCode =
  | "AUTHENTICATION_REQUIRED"
  | "TENANT_SCOPE_DENIED"
  | "VALIDATION_FAILED"
  | "VERSION_CONFLICT"
  | "RESOURCE_NOT_FOUND"
  | "PLUGIN_INCOMPATIBLE"
  | "CONSENT_REQUIRED"
  | "CONFIGURATION_INVALID"
  | "PAYLOAD_TOO_LARGE";

export class MorrowError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = "MorrowError";
    this.code = code;
  }
}

export function isMorrowError(error: unknown): error is MorrowError {
  return error instanceof MorrowError;
}
