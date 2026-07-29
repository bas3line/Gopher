import type { DatabasePool } from "./db/pool.ts";
import type { Coordinator } from "./infra/coordinator.ts";
import type { Logger } from "./logger.ts";

export function startHealthServer(options: {
  port: number;
  pool: DatabasePool;
  coordinator: Coordinator;
  discordReady: () => boolean;
  logger: Logger;
}): Bun.Server<undefined> {
  const server = Bun.serve({
    hostname: "0.0.0.0",
    port: options.port,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname !== "/healthz" && url.pathname !== "/readyz") {
        return new Response("not found", { status: 404 });
      }

      const checks = {
        postgres: false,
        redis: false,
        discord: options.discordReady(),
      };
      try {
        await options.pool.query("SELECT 1");
        checks.postgres = true;
      } catch {
        // The structured result below is enough; avoid leaking connection details.
      }
      try {
        checks.redis = (await options.coordinator.redis.ping()) === "PONG";
      } catch {
        // The structured result below is enough; avoid leaking connection details.
      }

      const healthy = checks.postgres && checks.redis && checks.discord;
      return Response.json(
        { status: healthy ? "ok" : "degraded", checks },
        {
          status: healthy ? 200 : 503,
          headers: { "cache-control": "no-store" },
        },
      );
    },
  });
  options.logger.info({ port: server.port }, "health server listening");
  return server;
}
