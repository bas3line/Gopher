import { describe, expect, test } from "bun:test";
import { loadConfig, normalizeChatCompletionsUrl } from "../src/config.ts";

const requiredEnvironment = {
  NODE_ENV: "test",
  TEXT_API_URL: "https://text-provider.example/openai/v1/chat/completions",
  TEXT_API_KEY: "text-test-key",
  TEXT_MODEL: "FW-GLM-5.2",
  CLOUDFLARE_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
  CLOUDFLARE_API_TOKEN: "cloudflare-test-token",
  OPENAI_BASE_URL: "https://provider.example/v1/chat/completions",
  OPENAI_API_KEY: "test-key",
  OPENAI_VISION_MODEL: "vision-model",
  DATABASE_URL: "postgresql://bot:password@localhost:5432/bot",
  REDIS_URL: "redis://localhost:6379/0",
};

describe("configuration", () => {
  test("preserves a full chat-completions endpoint", () => {
    expect(
      normalizeChatCompletionsUrl(
        "https://provider.example/v1/chat/completions",
      ),
    ).toBe("https://provider.example/v1/chat/completions");
  });

  test("appends chat/completions to a compatible base URL", () => {
    expect(normalizeChatCompletionsUrl("https://provider.example/v1/")).toBe(
      "https://provider.example/v1/chat/completions",
    );
  });

  test("loads bounded behavior defaults", () => {
    const config = loadConfig(requiredEnvironment);
    expect(config.openAI.maxTokens).toBe(2_400);
    expect(config.text.endpoint).toBe(
      "https://text-provider.example/openai/v1/chat/completions",
    );
    expect(config.text.model).toBe("FW-GLM-5.2");
    expect(config.text.maxTokens).toBe(2_400);
    expect(config.text.summaryMaxTokens).toBe(16_384);
    expect(config.text.reasoningEffort).toBe("none");
    expect(config.ownerUserIds).toEqual([]);
    expect(config.cloudflare.voiceFallback).toBeTrue();
    expect(config.cloudflare.voiceModel).toBe("@cf/deepgram/aura-2-en");
    expect(config.cloudflare.voiceSpeaker).toBe("amalthea");
    expect(config.fishAudio.referenceId).toBe(
      "ca3007f96ae7499ab87d27ea3599956a",
    );
    expect(config.fishAudio.model).toBe("s2-pro");
    expect(config.fishAudio.maxCharacters).toBe(1_800);
    expect(config.fishAudio.apiKey).toBeUndefined();
    expect(config.interactionMode).toBe("ambient");
    expect(config.ambientReplyChance).toBe(0.65);
    expect(config.ambientEvaluationCooldownSeconds).toBe(12);
    expect(config.maxVisionRequestsPerMinute).toBe(10);
    expect(config.summaryEveryMessages).toBe(40);
  });

  test("parses and validates configured Discord owner IDs", () => {
    const config = loadConfig({
      ...requiredEnvironment,
      BOT_OWNER_USER_IDS:
        "1530338228110884995, 1530338228110884995,1531809280062259260",
    });
    expect(config.ownerUserIds).toEqual([
      "1530338228110884995",
      "1531809280062259260",
    ]);
    expect(() =>
      loadConfig({
        ...requiredEnvironment,
        BOT_OWNER_USER_IDS: "1530338228110884995,not-an-id",
      }),
    ).toThrow("must be comma-separated Discord user IDs");
  });

  test("rejects cleartext non-local provider endpoints", () => {
    expect(() =>
      loadConfig({
        ...requiredEnvironment,
        OPENAI_BASE_URL: "http://provider.example/v1",
      }),
    ).toThrow("must use HTTPS");
    expect(() =>
      loadConfig({
        ...requiredEnvironment,
        TEXT_API_URL: "http://text-provider.example/openai/v1",
      }),
    ).toThrow("must use HTTPS");
  });

  test("allows a local cleartext provider for development", () => {
    const config = loadConfig({
      ...requiredEnvironment,
      OPENAI_BASE_URL: "http://127.0.0.1:8080/v1",
    });
    expect(config.openAI.baseUrl).toBe(
      "http://127.0.0.1:8080/v1/chat/completions",
    );
  });
});
