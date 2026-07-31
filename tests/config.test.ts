import { describe, expect, test } from "bun:test";
import {
  loadConfig,
  normalizeChatCompletionsUrl,
  normalizeEmbeddingsUrl,
} from "../src/config.ts";

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

  test("normalizes a base or chat endpoint to the embeddings endpoint", () => {
    expect(normalizeEmbeddingsUrl("https://provider.example/v1/")).toBe(
      "https://provider.example/v1/embeddings",
    );
    expect(
      normalizeEmbeddingsUrl(
        "https://provider.example/v1/chat/completions",
      ),
    ).toBe("https://provider.example/v1/embeddings");
  });

  test("loads bounded behavior defaults", () => {
    const config = loadConfig(requiredEnvironment);
    expect(config.openAI.maxTokens).toBe(2_400);
    expect(config.text.endpoint).toBe(
      "https://text-provider.example/openai/v1/chat/completions",
    );
    expect(config.text.model).toBe("FW-GLM-5.2");
    expect(config.text.maxTokens).toBe(16_384);
    expect(config.text.summaryMaxTokens).toBe(16_384);
    expect(config.text.memoryMaxTokens).toBe(8_192);
    expect(config.text.reasoningEffort).toBe("none");
    expect(config.embedding).toBeUndefined();
    expect(config.discordGuildId).toBe("1515356172092178512");
    expect(config.ownerUserIds).toEqual([]);
    expect(config.cloudflare.voiceFallback).toBeTrue();
    expect(config.cloudflare.voiceModel).toBe("@cf/deepgram/aura-2-en");
    expect(config.cloudflare.voiceSpeaker).toBe("amalthea");
    expect(config.cloudflare.sttModel).toBe("@cf/openai/whisper-large-v3-turbo");
    expect(config.voiceChat).toEqual({
      enabled: false,
      language: "en",
      maxUtteranceSeconds: 20,
      idleTimeoutSeconds: 900,
      maxReplyCharacters: 900,
    });
    expect(config.fishAudio.referenceId).toBe(
      "ca3007f96ae7499ab87d27ea3599956a",
    );
    expect(config.fishAudio.model).toBe("s2-pro");
    expect(config.fishAudio.maxCharacters).toBe(1_800);
    expect(config.fishAudio.apiKey).toBeUndefined();
    expect(config.music).toEqual({
      enabled: false,
      lavalinkUrl: "lavalink:2333",
      lavalinkSecure: false,
      defaultVolume: 65,
      maxQueueLength: 100,
      maxPlaylistTracks: 25,
      idleTimeoutSeconds: 120,
    });
    expect(config.interactionMode).toBe("ambient");
    expect(config.ambientReplyChance).toBe(0.65);
    expect(config.ambientEvaluationCooldownSeconds).toBe(12);
    expect(config.maxVisionRequestsPerMinute).toBe(10);
    expect(config.summaryEveryMessages).toBe(40);
    expect(config.agent).toEqual({
      enabled: true,
      discordActionsEnabled: true,
      maxIterations: 8,
      maxToolCalls: 24,
      maxParallelToolCalls: 6,
      runTimeoutMs: 120_000,
      toolTimeoutMs: 30_000,
    });
    expect(config.memory).toEqual({
      workerEnabled: true,
      batchSize: 32,
      pollMs: 750,
      recallCount: 12,
    });
  });

  test("requires a complete HTTPS embedding configuration", () => {
    expect(
      loadConfig({
        ...requiredEnvironment,
        EMBEDDING_API_URL: "https://provider.example/v1",
        EMBEDDING_API_KEY: "embedding-key",
        EMBEDDING_MODEL: "text-embedding-3-large",
      }).embedding,
    ).toEqual({
      endpoint: "https://provider.example/v1/embeddings",
      apiKey: "embedding-key",
      model: "text-embedding-3-large",
      dimensions: 1_024,
      batchSize: 64,
    });
    expect(() =>
      loadConfig({
        ...requiredEnvironment,
        EMBEDDING_API_URL: "https://provider.example/v1",
      }),
    ).toThrow("must be configured together");
    expect(() =>
      loadConfig({
        ...requiredEnvironment,
        EMBEDDING_API_URL: "http://provider.example/v1",
        EMBEDDING_API_KEY: "embedding-key",
        EMBEDDING_MODEL: "text-embedding-3-large",
      }),
    ).toThrow("must use HTTPS");
    expect(() =>
      loadConfig({
        ...requiredEnvironment,
        EMBEDDING_API_URL: "https://provider.example/v1",
        EMBEDDING_API_KEY: "embedding-key",
        EMBEDDING_MODEL: "text-embedding-3-large",
        EMBEDDING_DIMENSIONS: "768",
      }),
    ).toThrow("must be 1024");
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

  test("rejects a Discord guild outside the deployment allowlist", () => {
    expect(() =>
      loadConfig({
        ...requiredEnvironment,
        DISCORD_GUILD_ID: "111111111111111111",
      }),
    ).toThrow();
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

  test("requires a Lavalink password only when music is enabled", () => {
    expect(() =>
      loadConfig({ ...requiredEnvironment, MUSIC_ENABLED: "true" }),
    ).toThrow("is required when MUSIC_ENABLED=true");
    expect(
      loadConfig({
        ...requiredEnvironment,
        MUSIC_ENABLED: "true",
        LAVALINK_PASSWORD: "test-only-lavalink-password",
        MUSIC_DEFAULT_VOLUME: "80",
      }).music,
    ).toMatchObject({ enabled: true, defaultVolume: 80 });
  });

  test("bounds live voice-chat configuration", () => {
    expect(() =>
      loadConfig({
        ...requiredEnvironment,
        VOICE_CHAT_MAX_UTTERANCE_SECONDS: "31",
      }),
    ).toThrow();
    expect(
      loadConfig({
        ...requiredEnvironment,
        VOICE_CHAT_ENABLED: "true",
        VOICE_CHAT_LANGUAGE: "hi",
        VOICE_CHAT_MAX_REPLY_CHARACTERS: "1200",
      }).voiceChat,
    ).toMatchObject({ enabled: true, language: "hi", maxReplyCharacters: 1200 });
  });
});
