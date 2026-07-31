import type { DatabasePool } from "./pool.ts";

const migrations = [
  {
    version: "001_initial",
    path: new URL("./migrations/001_initial.sql", import.meta.url),
  },
  {
    version: "002_music",
    path: new URL("./migrations/002_music.sql", import.meta.url),
  },
  {
    version: "003_voice_chat",
    path: new URL("./migrations/003_voice_chat.sql", import.meta.url),
  },
  {
    version: "004_agent_memory",
    path: new URL("./migrations/004_agent_memory.sql", import.meta.url),
  },
  {
    version: "005_semantic_memory",
    path: new URL("./migrations/005_semantic_memory.sql", import.meta.url),
  },
  {
    version: "006_agent_reliability",
    path: new URL("./migrations/006_agent_reliability.sql", import.meta.url),
  },
  {
    version: "007_memory_graph",
    path: new URL("./migrations/007_memory_graph.sql", import.meta.url),
  },
  {
    version: "008_memory_worker_recovery",
    path: new URL("./migrations/008_memory_worker_recovery.sql", import.meta.url),
  },
] as const;

export async function migrate(pool: DatabasePool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(hashtext('go-senior-discord-bot-migrations'))");
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    for (const migration of migrations) {
      const existing = await client.query<{ version: string }>(
        "SELECT version FROM schema_migrations WHERE version = $1",
        [migration.version],
      );
      if (existing.rowCount) continue;

      const sql = await Bun.file(migration.path).text();
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [
          migration.version,
        ]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext('go-senior-discord-bot-migrations'))");
    client.release();
  }
}

if (import.meta.main) {
  const { loadConfig } = await import("../config.ts");
  const { createLogger } = await import("../logger.ts");
  const { createDatabasePool } = await import("./pool.ts");
  const config = loadConfig();
  const logger = createLogger(config);
  const pool = createDatabasePool(config.databaseUrl, logger);

  try {
    await migrate(pool);
    logger.info("database migrations complete");
  } finally {
    await pool.end();
  }
}
