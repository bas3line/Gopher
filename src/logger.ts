import pino from "pino";
import type { AppConfig } from "./config.ts";
import type { Writable } from "node:stream";

export function createLogger(
  config: Pick<AppConfig, "logLevel">,
  extraStreams: Writable[] = [],
) {
  const streams: Array<{ level: pino.Level; stream: Writable }> = [
    { level: (config.logLevel as pino.Level) || "info", stream: process.stdout },
    ...extraStreams.map((s) => ({ level: "info" as pino.Level, stream: s })),
  ];

  return pino({
    level: config.logLevel,
    redact: {
      paths: [
        "apiKey",
        "*.apiKey",
        "token",
        "*.token",
        "authorization",
        "req.headers.authorization",
        "config.openAI.apiKey",
        "config.cloudflare.apiToken",
        "config.discordToken",
        "config.firecrawlApiKey",
        "config.music.lavalinkPassword",
        "lavalinkPassword",
      ],
      censor: "[REDACTED]",
    },
    base: {
      service: "go-senior-discord-bot",
    },
  }, pino.multistream(streams));
}

export type Logger = ReturnType<typeof createLogger>;
