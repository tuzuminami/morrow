import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  type DataClassification,
  type DeletionMode,
  type MemorySource,
  type MemoryTenantContext,
  type MemoryType
} from "./memory-engine.js";
import { MorrowError } from "./errors.js";
import type { MorrowAuthenticator, MorrowPrincipal } from "./auth.js";
import type { MemoryRuntime } from "./runtime/memory-runtime.js";

export interface ApiServerOptions {
  readonly runtime: MemoryRuntime;
  readonly authenticator?: MorrowAuthenticator;
}

export interface HttpDispatchRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Record<string, string | undefined>;
  readonly bodyText?: string;
}

export interface HttpDispatchResponse {
  readonly statusCode: number;
  readonly body: unknown;
}

const MAX_REQUEST_BODY_BYTES = 1_048_576;
const MAX_RESPONSE_BODY_BYTES = 2_097_152;

export function createMorrowApiServer(options: ApiServerOptions): Server {
  const server = createServer(async (request, response) => {
    try {
      await routeRequest(options.runtime, options.authenticator, request, response);
    } catch (error) {
      writeError(response, error, request.headers["x-correlation-id"]);
    }
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;
  return server;
}

async function routeRequest(
  runtime: MemoryRuntime,
  authenticator: MorrowAuthenticator | undefined,
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  const result = await dispatchMorrowHttpRequest(runtime, authenticator, {
    method: request.method ?? "GET",
    path: request.url ?? "/",
    headers: normalizeHeaders(request.headers),
    bodyText: await readText(request)
  });
  writeJson(response, result.statusCode, result.body);
}

export async function dispatchMorrowHttpRequest(
  runtime: MemoryRuntime,
  authenticator: MorrowAuthenticator | undefined,
  request: HttpDispatchRequest
): Promise<HttpDispatchResponse> {
  try {
    if (Buffer.byteLength(request.bodyText ?? "", "utf8") > MAX_REQUEST_BODY_BYTES) {
      throw new MorrowError("PAYLOAD_TOO_LARGE", "Request body exceeds the 1 MiB limit.");
    }
    return await dispatchMorrowHttpRequestUnsafe(runtime, authenticator, request);
  } catch (error) {
    return errorResponse(error, request.headers["x-correlation-id"]);
  }
}

async function dispatchMorrowHttpRequestUnsafe(
  runtime: MemoryRuntime,
  authenticator: MorrowAuthenticator | undefined,
  request: HttpDispatchRequest
): Promise<HttpDispatchResponse> {
  const url = new URL(request.path, "http://localhost");

  if (request.method === "GET" && url.pathname === "/healthz") {
    const correlationId = request.headers["x-correlation-id"] ?? "corr_health";
    return json(200, { data: { status: "ok" }, meta: meta(correlationId) });
  }

  const context = await contextFromHeaders(authenticator, request.headers);

  if (request.method === "POST" && url.pathname === "/v1/retention-rules") {
    const body = readJsonText(request.bodyText);
    const data = await runtime.upsertRetentionRule(context, {
      memoryType: requireMemoryType(body.memoryType),
      purpose: requireString(body.purpose),
      ttlDays: requireNumber(body.ttlDays),
      deletionMode: requireDeletionMode(body.deletionMode)
    });
    return json(200, { data, meta: meta(context.correlationId) });
  }

  if (request.method === "POST" && url.pathname === "/v1/consent-receipts") {
    const body = readJsonText(request.bodyText);
    const data = await runtime.registerConsent(context, {
      subjectId: requireString(body.subjectId),
      purpose: requireString(body.purpose),
      scope: requireMemoryTypeArray(body.scope),
      expiresAt: requireString(body.expiresAt)
    });
    return json(200, { data, meta: meta(context.correlationId) });
  }

  if (request.method === "POST" && url.pathname === "/v1/memories") {
    const body = readJsonText(request.bodyText);
    const data = await runtime.registerMemory(context, {
      subjectId: requireString(body.subjectId),
      type: requireMemoryType(body.type),
      purpose: requireString(body.purpose),
      policyRef: requireString(body.policyRef),
      content: requireString(body.content),
      source: requireMemorySource(body.source),
      confidence: requireNumber(body.confidence),
      classification: requireDataClassification(body.classification),
      idempotencyKey: requiredHeader(request.headers, "idempotency-key")
    });
    return json(200, { data, meta: meta(context.correlationId) });
  }

  if (request.method === "POST" && url.pathname === "/v1/memories/query") {
    const body = readJsonText(request.bodyText);
    const data = {
      memories: await runtime.queryMemories(context, {
        subjectId: requireString(body.subjectId),
        type: requireMemoryType(body.type),
        purpose: requireString(body.purpose),
        policyRef: requireString(body.policyRef)
      })
    };
    return json(200, { data, meta: meta(context.correlationId) });
  }

  const revokeMatch = /^\/v1\/memories\/([^/]+)\/revoke$/.exec(url.pathname);
  if (request.method === "POST" && revokeMatch !== null) {
    const body = readJsonText(request.bodyText);
    const memoryId = revokeMatch[1];
    if (memoryId === undefined) {
      throw new MorrowError("VALIDATION_FAILED", "memoryId is required.");
    }
    const data = await runtime.revokeMemory(context, {
      memoryId,
      reason: requireString(body.reason),
      idempotencyKey: requiredHeader(request.headers, "idempotency-key")
    });
    return json(200, { data, meta: meta(context.correlationId) });
  }

  if (request.method === "POST" && url.pathname === "/v1/deletion-requests") {
    const body = readJsonText(request.bodyText);
    const data = await runtime.createDeletionRequest(context, {
      memoryId: requireString(body.memoryId),
      reason: requireString(body.reason),
      idempotencyKey: requiredHeader(request.headers, "idempotency-key")
    });
    return json(200, { data, meta: meta(context.correlationId) });
  }

  const exportMatch = /^\/v1\/subjects\/([^/]+)\/export$/.exec(url.pathname);
  if (request.method === "GET" && exportMatch !== null) {
    const subjectId = exportMatch[1];
    if (subjectId === undefined) {
      throw new MorrowError("VALIDATION_FAILED", "subjectId is required.");
    }
    const data = { memories: await runtime.exportSubject(context, decodeURIComponent(subjectId)) };
    return json(200, { data, meta: meta(context.correlationId) });
  }

  return json(404, {
    error: {
      code: "RESOURCE_NOT_FOUND",
      message: "Route was not found.",
      details: [],
      correlationId: context.correlationId
    }
  });
}

async function contextFromHeaders(
  authenticator: MorrowAuthenticator | undefined,
  headers: Record<string, string | undefined>
): Promise<MemoryTenantContext> {
  const principal = await authenticate(authenticator, headers.authorization);
  const headerTenantId = headers["x-tenant-id"];
  if (headerTenantId !== undefined && headerTenantId !== principal.tenantId) {
    throw new MorrowError("TENANT_SCOPE_DENIED", "Request tenant does not match authenticated principal.");
  }
  return {
    tenantId: principal.tenantId,
    actorId: principal.actorId,
    scopes: principal.scopes,
    correlationId: headers["x-correlation-id"] ?? `corr_${Date.now()}`
  };
}

async function authenticate(
  authenticator: MorrowAuthenticator | undefined,
  authorization: string | undefined
): Promise<MorrowPrincipal> {
  if (authenticator === undefined) {
    throw new MorrowError("AUTHENTICATION_REQUIRED", "Authentication is required.");
  }
  try {
    const principal = await authenticator.authenticate(authorization);
    if (principal === undefined) {
      throw new MorrowError("AUTHENTICATION_REQUIRED", "Authentication is required.");
    }
    return validatePrincipal(principal);
  } catch (error) {
    if (error instanceof MorrowError) {
      throw error;
    }
    throw new MorrowError("AUTHENTICATION_REQUIRED", "Authentication is required.");
  }
}

function validatePrincipal(principal: MorrowPrincipal): MorrowPrincipal {
  if (
    typeof principal.tenantId !== "string" || principal.tenantId.trim().length === 0 ||
    typeof principal.actorId !== "string" || principal.actorId.trim().length === 0 ||
    !Array.isArray(principal.scopes) ||
    principal.scopes.some((scope) => typeof scope !== "string" || scope.trim().length === 0)
  ) {
    throw new MorrowError("AUTHENTICATION_REQUIRED", "Authentication principal is invalid.");
  }
  return {
    tenantId: principal.tenantId,
    actorId: principal.actorId,
    scopes: [...principal.scopes]
  };
}

async function readText(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > MAX_REQUEST_BODY_BYTES) {
      throw new MorrowError("PAYLOAD_TOO_LARGE", "Request body exceeds the 1 MiB limit.");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function readJsonText(text = ""): Record<string, unknown> {
  if (text.trim().length === 0) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new MorrowError("VALIDATION_FAILED", "Request body must be valid JSON.");
  }
  return requireObject(parsed);
}

function writeJson(response: ServerResponse, statusCode: number, body: unknown): void {
  const serialized = JSON.stringify(body);
  if (Buffer.byteLength(serialized, "utf8") > MAX_RESPONSE_BODY_BYTES) {
    response.writeHead(413, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({
      error: {
        code: "PAYLOAD_TOO_LARGE",
        message: "Response exceeds the 2 MiB limit.",
        details: [],
        correlationId: "corr_response_limit"
      }
    }));
    return;
  }
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(serialized);
}

function writeError(response: ServerResponse, error: unknown, correlationHeader: string | string[] | undefined): void {
  const correlationId = Array.isArray(correlationHeader) ? correlationHeader[0] : (correlationHeader ?? "corr_unknown");
  const result = errorResponse(error, correlationId);
  writeJson(response, result.statusCode, result.body);
}

function errorResponse(error: unknown, correlationHeader: string | undefined): HttpDispatchResponse {
  const correlationId = correlationHeader ?? "corr_unknown";
  if (error instanceof MorrowError) {
    const status = errorStatus(error.code);
    return json(status, {
      error: {
        code: error.code,
        message: error.message,
        details: [],
        correlationId
      }
    });
  }
  return json(500, {
    error: {
      code: "DEPENDENCY_UNAVAILABLE",
      message: "Request failed safely.",
      details: [],
      correlationId
    }
  });
}

function json(statusCode: number, body: unknown): HttpDispatchResponse {
  return { statusCode, body };
}

function errorStatus(code: string): number {
  if (code === "AUTHENTICATION_REQUIRED") {
    return 401;
  }
  if (code === "TENANT_SCOPE_DENIED" || code === "CONSENT_REQUIRED") {
    return 403;
  }
  if (code === "VERSION_CONFLICT" || code === "CONFIGURATION_INVALID") {
    return 409;
  }
  if (code === "RESOURCE_NOT_FOUND") {
    return 404;
  }
  if (code === "PAYLOAD_TOO_LARGE") {
    return 413;
  }
  return 422;
}

function meta(correlationId: string): { readonly requestId: string; readonly correlationId: string; readonly apiVersion: "v1" } {
  return {
    requestId: `req_${Date.now()}`,
    correlationId,
    apiVersion: "v1"
  };
}

function requiredHeader(headers: Record<string, string | undefined>, name: string): string {
  const value = headers[name];
  if (value === undefined || value.trim().length === 0) {
    throw new MorrowError("VALIDATION_FAILED", `${name} header is required.`);
  }
  return value;
}

function requireString(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new MorrowError("VALIDATION_FAILED", "Expected non-empty string.");
  }
  return value;
}

function requireNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new MorrowError("VALIDATION_FAILED", "Expected number.");
  }
  return value;
}

function requireStringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim().length === 0)) {
    throw new MorrowError("VALIDATION_FAILED", "Expected string array.");
  }
  return value;
}

function requireMemoryType(value: unknown): MemoryType {
  const raw = requireString(value);
  if (!["episodic", "fact", "preference", "relationship", "instruction"].includes(raw)) {
    throw new MorrowError("VALIDATION_FAILED", "Unsupported memory type.");
  }
  return raw as MemoryType;
}

function requireMemoryTypeArray(value: unknown): readonly MemoryType[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new MorrowError("VALIDATION_FAILED", "Expected non-empty memory type array.");
  }
  return value.map((item) => requireMemoryType(item));
}

function requireDeletionMode(value: unknown): DeletionMode {
  const raw = requireString(value);
  if (raw !== "soft_delete" && raw !== "hard_delete") {
    throw new MorrowError("VALIDATION_FAILED", "Unsupported deletion mode.");
  }
  return raw;
}

function requireDataClassification(value: unknown): DataClassification {
  const raw = requireString(value);
  if (!["public", "internal", "sensitive"].includes(raw)) {
    throw new MorrowError("VALIDATION_FAILED", "Unsupported data classification.");
  }
  return raw as DataClassification;
}

function requireMemorySource(value: unknown): MemorySource {
  const source = requireObject(value);
  const kind = requireString(source.kind);
  if (kind !== "user_statement" && kind !== "system_observation" && kind !== "operator_import") {
    throw new MorrowError("VALIDATION_FAILED", "Unsupported memory source kind.");
  }
  return {
    kind,
    reference: requireString(source.reference)
  };
}

function requireObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new MorrowError("VALIDATION_FAILED", "Expected object.");
  }
  return value as Record<string, unknown>;
}

function normalizeHeaders(headers: IncomingMessage["headers"]): Record<string, string | undefined> {
  const normalized: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(headers)) {
    normalized[key.toLowerCase()] = Array.isArray(value) ? value[0] : value;
  }
  return normalized;
}
