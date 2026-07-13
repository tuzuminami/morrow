import { Pool } from "pg";

import { PooledSqlTransactionProvider, PostgresMemoryStore } from "./postgres-memory-store.js";
import { PostgresMemoryRuntime } from "../runtime/postgres-memory-runtime.js";

import type { MemoryClock, MemoryIdGenerator } from "../memory-engine.js";

export interface PostgresPoolOptions {
  readonly connectionString: string;
  readonly max?: number;
  readonly connectionTimeoutMillis?: number;
  readonly idleTimeoutMillis?: number;
}

export function createPostgresMemoryStore(
  options: PostgresPoolOptions,
  ids: MemoryIdGenerator,
  clock: MemoryClock
): { readonly pool: Pool; readonly store: PostgresMemoryStore } {
  const pool = new Pool({
    connectionString: options.connectionString,
    max: options.max ?? 10,
    connectionTimeoutMillis: options.connectionTimeoutMillis ?? 5_000,
    idleTimeoutMillis: options.idleTimeoutMillis ?? 30_000
  });
  pool.on("error", (error) => {
    console.error(JSON.stringify({
      event: "morrow.postgres.idle_client_error",
      code: postgresErrorCode(error)
    }));
  });
  return { pool, store: new PostgresMemoryStore(new PooledSqlTransactionProvider(pool), ids, clock) };
}

export function createPostgresMemoryRuntime(
  options: PostgresPoolOptions,
  ids: MemoryIdGenerator,
  clock: MemoryClock
): { readonly pool: Pool; readonly runtime: PostgresMemoryRuntime } {
  const pool = new Pool({
    connectionString: options.connectionString,
    max: options.max ?? 10,
    connectionTimeoutMillis: options.connectionTimeoutMillis ?? 5_000,
    idleTimeoutMillis: options.idleTimeoutMillis ?? 30_000
  });
  pool.on("error", (error) => {
    console.error(JSON.stringify({
      event: "morrow.postgres.idle_client_error",
      code: postgresErrorCode(error)
    }));
  });
  return { pool, runtime: new PostgresMemoryRuntime(new PooledSqlTransactionProvider(pool), ids, clock) };
}

function postgresErrorCode(error: Error): string {
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === "string" ? code : "unknown";
}
