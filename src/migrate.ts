#!/usr/bin/env node

import { migrateDatabase } from "./database-migrations.js";
import { packageMigrationsDirectory } from "./migration-path.js";
import { createPostgresMemoryStore } from "./storage/postgres-pool.js";
import { RandomMemoryIds, RealtimeMemoryClock } from "./memory-engine.js";

const connectionString = process.env.MORROW_DATABASE_URL;
if (connectionString === undefined || connectionString.trim().length === 0) {
  throw new Error("MORROW_DATABASE_URL is required to migrate MORROW.");
}

const { pool } = createPostgresMemoryStore({ connectionString }, new RandomMemoryIds(), new RealtimeMemoryClock());
try {
  const applied = await migrateDatabase(pool, packageMigrationsDirectory());
  console.log(JSON.stringify({ event: "morrow.database.migrated", applied }));
} finally {
  await pool.end();
}
