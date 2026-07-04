import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  InMemoryMemoryEngine,
  MorrowError,
  RandomMemoryIds,
  RealtimeMemoryClock,
  type MemoryTenantContext
} from "./index.ts";

export interface ApiServerOptions {
  readonly engine?: InMemoryMemoryEngine;
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
  const url = new URL(request.url ?? "/", "http://localhost");
  const context = contextFromHeaders(request);

  if (request.method === "GET" && url.pathname === "/healthz") {
    writeJson(response, 200, { data: { status: "ok" }, meta: meta(context) });
    return;
  }

  if (request.method === "POST" && url.pathname === "/v1/retention-rules") {
    const body = await readJson(request);
    const data = engine.upsertRetentionRule(context, {
      memoryType: requireString(body.memoryType),
      purpose: requireString(body.purpose),
      ttlDays: requireNumber(body.ttlDays),
      deletionMode: requireString(body.deletionMode)
    });
    writeJson(response, 200, { data, meta: meta(context) });
    return;
  }

  if (request.method === "POST" && url.pathname === "/v1/consent-receipts") {
    const body = await readJson(request);
    const data = engine.registerConsent(context, {
      subjectId: requireString(body.subjectId),
      purpose: requireString(body.purpose),
      scope: requireStringArray(body.scope),
      expiresAt: requireString(body.expiresAt)
    });
    writeJson(response, 200, { data, meta: meta(context) });
    return;
  }

  if (request.method === "POST" && url.pathname === "/v1/memories") {
    const body = await readJson(request);
    const data = engine.registerMemory(context, {
      subjectId: requireString(body.subjectId),
      type: requireString(body.type),
      purpose: requireString(body.purpose),
      policyRef: requireString(body.policyRef),
      content: requireString(body.content),
      source: requireObject(body.source),
      confidence: requireNumber(body.confidence),
      classification: requireString(body.classification),
      idempotencyKey: requiredHeader(request, "idempotency-key")
    });
    writeJson(response, 200, { data, meta: meta(context) });
    return;
  }

  if (request.method === "POST" && url.pathname === "/v1/memories/query") {
    const body = await readJson(request);
    const data = {
      memories: engine.queryMemories(context, {
        subjectId: requireString(body.subjectId),
        purpose: requireString(body.purpose),
        policyRef: requireString(body.policyRef)
      })
    };
    writeJson(response, 200, { data, meta: meta(context) });
    return;
  }

  const revokeMatch = /^\/v1\/memories\/([^/]+)\/revoke$/.exec(url.pathname);
  if (request.method === "POST" && revokeMatch !== null) {
    const body = await readJson(request);
    const memoryId = revokeMatch[1];
    if (memoryId === undefined) {
      throw new MorrowError("VALIDATION_FAILED", "memoryId is required.");
    }
    const data = engine.revokeMemory(context, {
      memoryId,
      reason: requireString(body.reason),
      idempotencyKey: requiredHeader(request, "idempotency-key")
    });
    writeJson(response, 200, { data, meta: meta(context) });
    return;
  }

  writeJson(response, 404, {
    error: {
      code: "RESOURCE_NOT_FOUND",
      message: "Route was not found.",
      details: [],
      correlationId: context.correlationId
    }
  });
}

function contextFromHeaders(request: IncomingMessage): MemoryTenantContext {
  const authorization = request.headers.authorization;
  if (authorization === undefined || !authorization.startsWith("Bearer ")) {
    throw new MorrowError("TENANT_SCOPE_DENIED", "Authentication is required.");
  }
  const tenantId = requiredHeader(request, "x-tenant-id");
  const actorId = authorization.slice("Bearer ".length).trim();
  if (actorId.length === 0) {
    throw new MorrowError("TENANT_SCOPE_DENIED", "Authentication is required.");
  }
  return {
    tenantId,
    actorId,
    scopes: scopesFromHeader(request),
    correlationId: optionalHeader(request, "x-correlation-id") ?? `corr_${Date.now()}`
  };
}

function scopesFromHeader(request: IncomingMessage): readonly string[] {
  const raw = optionalHeader(request, "x-morrow-scopes");
  if (raw === undefined) {
    return [];
  }
  return raw.split(" ").map((scope) => scope.trim()).filter(Boolean);
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.trim().length === 0) {
    return {};
  }
  const parsed: unknown = JSON.parse(text);
  return requireObject(parsed);
}

function writeJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function writeError(response: ServerResponse, error: unknown, correlationHeader: string | string[] | undefined): void {
  const correlationId = Array.isArray(correlationHeader) ? correlationHeader[0] : (correlationHeader ?? "corr_unknown");
  if (error instanceof MorrowError) {
    const status = errorStatus(error.code);
    writeJson(response, status, {
      error: {
        code: error.code,
        message: error.message,
        details: [],
        correlationId
      }
    });
    return;
  }
  writeJson(response, 500, {
    error: {
      code: "DEPENDENCY_UNAVAILABLE",
      message: "Request failed safely.",
      details: [],
      correlationId
    }
  });
}

function errorStatus(code: string): number {
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

function meta(context: MemoryTenantContext): { readonly requestId: string; readonly correlationId: string; readonly apiVersion: "v1" } {
  return {
    requestId: `req_${Date.now()}`,
    correlationId: context.correlationId,
    apiVersion: "v1"
  };
}

function requiredHeader(request: IncomingMessage, name: string): string {
  const value = optionalHeader(request, name);
  if (value === undefined || value.trim().length === 0) {
    throw new MorrowError("VALIDATION_FAILED", `${name} header is required.`);
  }
  return value;
}

function optionalHeader(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
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

function requireObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new MorrowError("VALIDATION_FAILED", "Expected object.");
  }
  return value as Record<string, unknown>;
}
