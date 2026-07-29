import { describe, expect, test } from "bun:test";
import {
  WebResearch,
  WebResearchError,
  normalizeFirecrawlItem,
} from "../src/web/firecrawl.ts";
import { createLogger } from "../src/logger.ts";
import { loadConfig } from "../src/config.ts";

describe("Firecrawl normalization", () => {
  test("fails explicitly when live web research is not configured", async () => {
    const config = loadConfig({
      NODE_ENV: "test",
      TEXT_API_URL: "https://text-provider.example/openai/v1/chat/completions",
      TEXT_API_KEY: "text-test-key",
      CLOUDFLARE_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
      CLOUDFLARE_API_TOKEN: "cloudflare-test-token",
      OPENAI_BASE_URL: "https://provider.example/v1/chat/completions",
      OPENAI_API_KEY: "test-key",
      OPENAI_VISION_MODEL: "vision-model",
      DATABASE_URL: "postgresql://bot:password@localhost:5432/bot",
      REDIS_URL: "redis://localhost:6379/0",
      LOG_LEVEL: "silent",
    });
    const research = new WebResearch(undefined, 5, createLogger(config));
    expect(research.enabled).toBe(false);
    expect(research.search("latest Go release")).rejects.toBeInstanceOf(
      WebResearchError,
    );
  });

  test("normalizes a scraped document", () => {
    const source = normalizeFirecrawlItem({
      markdown: "# Current docs",
      metadata: {
        sourceURL: "https://go.dev/doc/",
        title: "Go Documentation",
        description: "Official docs",
      },
    });
    expect(source).toEqual({
      title: "Go Documentation",
      url: "https://go.dev/doc/",
      description: "Official docs",
      content: "# Current docs",
    });
  });

  test("normalizes a news result", () => {
    const source = normalizeFirecrawlItem({
      url: "https://example.com/news",
      title: "Release",
      snippet: "Something shipped",
      date: "2026-07-28",
    });
    expect(source?.content).toBe("Something shipped");
    expect(source?.publishedAt).toBe("2026-07-28");
  });

  test("rejects non-web URLs", () => {
    expect(
      normalizeFirecrawlItem({
        url: "file:///etc/passwd",
        title: "nope",
        description: "nope",
      }),
    ).toBeUndefined();
  });
});
