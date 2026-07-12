import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { MorrowError } from "./errors.js";

import type { SqlClient, SqlPool } from "./storage/postgres-memory-store.js";

const MIGRATION_LOCK_ID = 746_338_211;

interface AppliedMigrationRow {
  readonly filename: string;
  readonly checksum: string;
}

interface ExistingSchemaRow {
  readonly exists: boolean;
}

export interface DatabaseMigration {
  readonly filename: string;
  readonly sql: string;
  readonly checksum: string;
}

export async function loadDatabaseMigrations(migrationsDirectory: string): Promise<readonly DatabaseMigration[]> {
  const filenames = (await readdir(migrationsDirectory))
    .filter((filename) => /^\d+_[a-z0-9_]+\.sql$/i.test(filename))
    .sort();

  return Promise.all(filenames.map(async (filename) => {
    const sql = await readFile(join(migrationsDirectory, filename), "utf8");
    return { filename, sql, checksum: sha256(sql) };
  }));
}

export async function migrateDatabase(pool: SqlPool, migrationsDirectory: string): Promise<readonly string[]> {
  const migrations = await loadDatabaseMigrations(migrationsDirectory);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_LOCK_ID]);
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
        filename TEXT PRIMARY KEY,
        checksum TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL
      )`
    );
    const applied = await client.query<AppliedMigrationRow>(
      "SELECT filename, checksum FROM schema_migrations ORDER BY filename ASC"
    );
    assertNoUnknownMigrations(migrations, applied.rows);
    const appliedByFilename = new Map(applied.rows.map((row) => [row.filename, row.checksum]));
    if (applied.rows.length === 0 && await hasExistingMorrowSchema(client)) {
      throw new MorrowError(
        "CONFIGURATION_INVALID",
        "Existing MORROW schema has no migration ledger; refuse automatic V1 baseline adoption."
      );
    }
    const appliedNow: string[] = [];

    for (const migration of migrations) {
      const existingChecksum = appliedByFilename.get(migration.filename);
      if (existingChecksum !== undefined) {
        if (existingChecksum !== migration.checksum) {
          throw new MorrowError("CONFIGURATION_INVALID", `Migration checksum mismatch for ${migration.filename}.`);
        }
        continue;
      }
      await client.query(migration.sql);
      await client.query(
        "INSERT INTO schema_migrations (filename, checksum, applied_at) VALUES ($1, $2, $3)",
        [migration.filename, migration.checksum, new Date().toISOString()]
      );
      appliedNow.push(migration.filename);
    }

    await client.query("COMMIT");
    return appliedNow;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function hasExistingMorrowSchema(client: SqlClient): Promise<boolean> {
  const result = await client.query<ExistingSchemaRow>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_schema = current_schema()
         AND table_name = ANY($1::text[])
     ) AS exists`,
    [CORE_TABLES]
  );
  return result.rows[0]?.exists === true;
}

export async function assertDatabaseReady(pool: SqlPool, migrationsDirectory: string): Promise<void> {
  const migrations = await loadDatabaseMigrations(migrationsDirectory);
  const result = await pool.connect();
  try {
    const applied = await result.query<AppliedMigrationRow>(
      "SELECT filename, checksum FROM schema_migrations ORDER BY filename ASC"
    );
    assertNoUnknownMigrations(migrations, applied.rows);
    const appliedByFilename = new Map(applied.rows.map((row) => [row.filename, row.checksum]));
    for (const migration of migrations) {
      if (appliedByFilename.get(migration.filename) !== migration.checksum) {
        throw new MorrowError("CONFIGURATION_INVALID", "Database migrations are not current.");
      }
    }
  } catch (error) {
    if (error instanceof MorrowError) {
      throw error;
    }
    throw new MorrowError("CONFIGURATION_INVALID", "Database schema is not ready.");
  } finally {
    result.release();
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function assertNoUnknownMigrations(migrations: readonly DatabaseMigration[], applied: readonly AppliedMigrationRow[]): void {
  const known = new Set(migrations.map((migration) => migration.filename));
  if (applied.some((migration) => !known.has(migration.filename))) {
    throw new MorrowError("CONFIGURATION_INVALID", "Database contains an unknown migration record.");
  }
}

const CORE_TABLES = [
  "consent_receipts",
  "retention_rules",
  "memories",
  "idempotency_keys",
  "deletion_requests",
  "audit_events",
  "outbox_events"
];
