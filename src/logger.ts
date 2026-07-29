import pino from "pino";
import type { AppConfig } from "./config.ts";

export function createLogger(config: Pick<AppConfig, "logLevel">) {
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
  });
}

export type Logger = ReturnType<typeof createLogger>;
