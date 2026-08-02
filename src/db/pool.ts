import pg from "pg";
import type { Logger } from "../logger.ts";

const { Pool } = pg;

export type DatabasePool = InstanceType<typeof Pool>;

export function createDatabasePool(connectionString: string, logger: Logger): DatabasePool {
  const sslMode = resolveSslMode(connectionString);
  const pool = new Pool({
    connectionString,
    max: 12,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 8_000,
    application_name: "go-senior-discord-bot",
    ssl: sslMode ? { rejectUnauthorized: sslMode !== "no-verify" } : undefined,
  });

  pool.on("error", (error) => {
    logger.error({ err: error }, "idle PostgreSQL client error");
  });

  return pool;
}

function resolveSslMode(
  connectionString: string,
): "verify-full" | "no-verify" | undefined {
  const url = new URL(connectionString);
  const hostname = url.hostname;
  // Plaintext nepgotiation for local/Docker Compose development hosts.
  if (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "postgres"
  ) {
    return undefined;
  }
  // Railway internal networking uses self-signed certificates.
  if (hostname.endsWith(".railway.internal")) {
    return "no-verify";
  }
  return "verify-full";
}
