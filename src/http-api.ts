import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  InMemoryMemoryEngine,
  MorrowError,
  RandomMemoryIds,
  RealtimeMemoryClock,
  type DataClassification,
  type DeletionMode,
  type MemorySource,
  type MemoryTenantContext,
  type MemoryType
} from "./index.js";

export interface ApiServerOptions {
  readonly engine?: InMemoryMemoryEngine;
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

export function createMorrowApiServer(options: ApiServerOptions = {}): Server {
  const engine = options.engine ?? new InMemoryMemoryEngine(new RealtimeMemoryClock(), new RandomMemoryIds());

  return createServer(async (request, response) => {
    try {
      await routeRequest(engine, request, response);
    } catch (error) {
      writeError(response, error, request.headers["x-correlation-id"]);
    }
  });
}

async function routeRequest(engine: InMemoryMemoryEngine, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const result = await dispatchMorrowHttpRequest(engine, {
    method: request.method ?? "GET",
    path: request.url ?? "/",
    headers: normalizeHeaders(request.headers),
    bodyText: await readText(request)
  });
  writeJson(response, result.statusCode, result.body);
}

export async function dispatchMorrowHttpRequest(
  engine: InMemoryMemoryEngine,
  request: HttpDispatchRequest
): Promise<HttpDispatchResponse> {
  try {
    return await dispatchMorrowHttpRequestUnsafe(engine, request);
  } catch (error) {
    return errorResponse(error, request.headers["x-correlation-id"]);
  }
}

async function dispatchMorrowHttpRequestUnsafe(
  engine: InMemoryMemoryEngine,
  request: HttpDispatchRequest
): Promise<HttpDispatchResponse> {
  const url = new URL(request.path, "http://localhost");

  if (request.method === "GET" && url.pathname === "/healthz") {
    const correlationId = request.headers["x-correlation-id"] ?? "corr_health";
    return json(200, { data: { status: "ok" }, meta: meta(correlationId) });
  }

  const context = contextFromHeaders(request.headers);

  if (request.method === "POST" && url.pathname === "/v1/retention-rules") {
    const body = readJsonText(request.bodyText);
    const data = engine.upsertRetentionRule(context, {
      memoryType: requireMemoryType(body.memoryType),
      purpose: requireString(body.purpose),
      ttlDays: requireNumber(body.ttlDays),
      deletionMode: requireDeletionMode(body.deletionMode)
    });
    return json(200, { data, meta: meta(context.correlationId) });
  }

  if (request.method === "POST" && url.pathname === "/v1/consent-receipts") {
    const body = readJsonText(request.bodyText);
    const data = engine.registerConsent(context, {
      subjectId: requireString(body.subjectId),
      purpose: requireString(body.purpose),
      scope: requireMemoryTypeArray(body.scope),
      expiresAt: requireString(body.expiresAt)
    });
    return json(200, { data, meta: meta(context.correlationId) });
  }

  if (request.method === "POST" && url.pathname === "/v1/memories") {
    const body = readJsonText(request.bodyText);
    const data = engine.registerMemory(context, {
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
      memories: engine.queryMemories(context, {
        subjectId: requireString(body.subjectId),
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
    const data = engine.revokeMemory(context, {
      memoryId,
      reason: requireString(body.reason),
      idempotencyKey: requiredHeader(request.headers, "idempotency-key")
    });
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

function contextFromHeaders(headers: Record<string, string | undefined>): MemoryTenantContext {
  const authorization = headers.authorization;
  if (authorization === undefined || !authorization.startsWith("Bearer ")) {
    throw new MorrowError("AUTHENTICATION_REQUIRED", "Authentication is required.");
  }
  const tenantId = requiredHeader(headers, "x-tenant-id");
  const actorId = authorization.slice("Bearer ".length).trim();
  if (actorId.length === 0) {
    throw new MorrowError("AUTHENTICATION_REQUIRED", "Authentication is required.");
  }
  return {
    tenantId,
    actorId,
    scopes: scopesFromHeader(headers),
    correlationId: headers["x-correlation-id"] ?? `corr_${Date.now()}`
  };
}

function scopesFromHeader(headers: Record<string, string | undefined>): readonly string[] {
  const raw = headers["x-morrow-scopes"];
  if (raw === undefined) {
    return [];
  }
  return raw.split(" ").map((scope) => scope.trim()).filter(Boolean);
}

async function readText(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
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
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
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
