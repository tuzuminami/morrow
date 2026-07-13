#!/usr/bin/env node

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { assertDatabaseReady } from "./database-migrations.js";
import { createMorrowApiServer } from "./http-api.js";
import { RandomMemoryIds, RealtimeMemoryClock } from "./memory-engine.js";
import { packageMigrationsDirectory } from "./migration-path.js";
import { createPostgresMemoryRuntime } from "./storage/postgres-pool.js";
import type { MorrowAuthenticator } from "./auth.js";

void main().catch(() => {
  console.error(JSON.stringify({ event: "morrow.api.start_failed", code: "CONFIGURATION_OR_DEPENDENCY_UNAVAILABLE" }));
  process.exitCode = 1;
});

async function main(): Promise<void> {
  const connectionString = requiredEnvironment("MORROW_DATABASE_URL");
  const authModule = requiredEnvironment("MORROW_AUTH_MODULE");
  const port = parsePort(process.env.PORT ?? "3000");
  const host = process.env.HOST ?? "127.0.0.1";
  const shutdownTimeout = parseShutdownTimeout(process.env.MORROW_SHUTDOWN_TIMEOUT_MS ?? "30000");
  if (!isLoopbackHost(host) && process.env.MORROW_TLS_TERMINATED !== "true") {
    throw new Error("Non-loopback HOST requires MORROW_TLS_TERMINATED=true behind a trusted TLS terminator.");
  }
  const { pool, runtime } = createPostgresMemoryRuntime({ connectionString }, new RandomMemoryIds(), new RealtimeMemoryClock());
  const authenticator = await loadAuthenticator(authModule);
  await assertDatabaseReady(pool, packageMigrationsDirectory());
  const server = createMorrowApiServer({
    runtime,
    authenticator,
    readiness: () => assertDatabaseReady(pool, packageMigrationsDirectory())
  });

  server.once("error", () => {
    console.error(JSON.stringify({ event: "morrow.api.listen_failed", code: "DEPENDENCY_UNAVAILABLE" }));
    void pool.end().finally(() => process.exit(1));
  });

  server.listen(port, host, () => {
    console.log(JSON.stringify({ event: "morrow.api.started", host, port }));
  });

  let closing = false;
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      if (closing) {
        return;
      }
      closing = true;
      const timeout = setTimeout(() => {
        console.error(JSON.stringify({ event: "morrow.api.shutdown_timeout" }));
        process.exit(1);
      }, shutdownTimeout);
      timeout.unref();
      server.close((error) => {
        clearTimeout(timeout);
        if (error !== undefined) {
          console.error(JSON.stringify({ event: "morrow.api.shutdown_failed" }));
          process.exit(1);
        }
        void pool.end().then(
          () => process.exit(0),
          () => {
            console.error(JSON.stringify({ event: "morrow.postgres.shutdown_failed" }));
            process.exit(1);
          }
        );
      });
    });
  }
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function parsePort(value: string): number {
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT must be a valid TCP port.");
  }
  return port;
}

function parseShutdownTimeout(value: string): number {
  const timeout = Number.parseInt(value, 10);
  if (!Number.isInteger(timeout) || timeout < 1_000 || timeout > 120_000) {
    throw new Error("MORROW_SHUTDOWN_TIMEOUT_MS must be an integer between 1000 and 120000.");
  }
  return timeout;
}

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

async function loadAuthenticator(modulePath: string): Promise<MorrowAuthenticator> {
  const moduleUrl = modulePath.startsWith("file:")
    ? modulePath
    : pathToFileURL(resolve(process.cwd(), modulePath)).href;
  const loaded: unknown = await import(moduleUrl);
  if (typeof loaded !== "object" || loaded === null || !("authenticator" in loaded)) {
    throw new Error("MORROW_AUTH_MODULE must export an authenticator.");
  }
  const authenticator = (loaded as { readonly authenticator?: unknown }).authenticator;
  if (typeof authenticator !== "object" || authenticator === null || !("authenticate" in authenticator) ||
      typeof (authenticator as { readonly authenticate?: unknown }).authenticate !== "function") {
    throw new Error("MORROW_AUTH_MODULE authenticator must provide authenticate(authorization).");
  }
  return authenticator as MorrowAuthenticator;
}
