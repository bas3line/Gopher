import pg from "pg";
import type { Logger } from "../logger.ts";

const { Pool } = pg;

export type DatabasePool = InstanceType<typeof Pool>;

export function createDatabasePool(connectionString: string, logger: Logger): DatabasePool {
  const pool = new Pool({
    connectionString,
    max: 12,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 8_000,
    application_name: "go-senior-discord-bot",
    ssl: shouldUseTls(connectionString) ? { rejectUnauthorized: true } : undefined,
  });

  pool.on("error", (error) => {
    logger.error({ err: error }, "idle PostgreSQL client error");
  });

  return pool;
}

function shouldUseTls(connectionString: string): boolean {
  const url = new URL(connectionString);
  return !new Set(["localhost", "127.0.0.1", "postgres"]).has(url.hostname);
}
