import { z } from "zod";
import { DEFAULT_ALLOWED_GUILD_IDS } from "./discord/guild-policy.ts";

const optionalTrimmed = z
  .string()
  .optional()
  .transform((value) => value?.trim() || undefined);

const configSchema = z
  .object({
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    DISCORD_TOKEN: optionalTrimmed,
    DISCORD_GUILD_ID: z
      .string()
      .regex(/^(?:\d{17,20}(?:\s*,\s*\d{17,20})*)?$/)
      .default(DEFAULT_ALLOWED_GUILD_IDS.join(",")),
    BOT_OWNER_USER_IDS: z
      .string()
      .trim()
      .regex(
        /^(?:\d{17,20}(?:\s*,\s*\d{17,20})*)?$/,
        "must be comma-separated Discord user IDs",
      )
      .default(""),
    TEXT_API_URL: z.string().url(),
    TEXT_API_KEY: z.string().min(1),
    TEXT_MODEL: z.string().min(1).default("FW-GLM-5.2"),
    TEXT_MAX_TOKENS: z.coerce
      .number()
      .int()
      .min(256)
      .max(32_768)
      .default(16_384),
    SUMMARY_MAX_TOKENS: z.coerce
      .number()
      .int()
      .min(256)
      .max(32_768)
      .default(16_384),
    MEMORY_MAX_TOKENS: z.coerce
      .number()
      .int()
      .min(512)
      .max(32_768)
      .default(8_192),
    EMBEDDING_API_URL: optionalTrimmed,
    EMBEDDING_API_KEY: optionalTrimmed,
    EMBEDDING_MODEL: optionalTrimmed,
    EMBEDDING_DIMENSIONS: z.coerce
      .number()
      .int()
      .refine(
        (value) => value === 1_024,
        "must be 1024 to match the semantic-memory vector schema",
      )
      .default(1_024),
    EMBEDDING_BATCH_SIZE: z.coerce
      .number()
      .int()
      .min(1)
      .max(128)
      .default(64),
    TEXT_REASONING_EFFORT: z
      .enum(["none", "low", "medium", "high", "max", "xhigh"])
      .default("none"),
    CLOUDFLARE_ACCOUNT_ID: z.string().regex(/^[a-f0-9]{32}$/i),
    CLOUDFLARE_API_TOKEN: z.string().min(1),
    CLOUDFLARE_VOICE_FALLBACK: z
      .enum(["true", "false"])
      .default("true")
      .transform((value) => value === "true"),
    CLOUDFLARE_VOICE_MODEL: z
      .string()
      .regex(/^@cf\/[a-z0-9._-]+\/[a-z0-9._-]+$/i)
      .default("@cf/deepgram/aura-2-en"),
    CLOUDFLARE_VOICE_SPEAKER: z
      .string()
      .regex(/^[a-z0-9._-]+$/i)
      .default("amalthea"),
    CLOUDFLARE_STT_MODEL: z
      .string()
      .regex(/^@cf\/[a-z0-9._-]+\/[a-z0-9._-]+$/i)
      .default("@cf/openai/whisper-large-v3-turbo"),
    VOICE_CHAT_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    VOICE_CHAT_LANGUAGE: z
      .string()
      .trim()
      .regex(/^[a-z]{2,3}(?:-[a-z]{2,4})?$/i, "must be an ISO language code")
      .default("en"),
    VOICE_CHAT_MAX_UTTERANCE_SECONDS: z.coerce
      .number()
      .int()
      .min(3)
      .max(30)
      .default(20),
    VOICE_CHAT_IDLE_TIMEOUT_SECONDS: z.coerce
      .number()
      .int()
      .min(60)
      .max(3_600)
      .default(900),
    VOICE_CHAT_MAX_REPLY_CHARACTERS: z.coerce
      .number()
      .int()
      .min(100)
      .max(2_000)
      .default(900),
    OPENAI_BASE_URL: z.string().url(),
    OPENAI_API_KEY: z.string().min(1),
    OPENAI_VISION_MODEL: z.string().min(1),
    OPENAI_MAX_TOKENS: z.coerce
      .number()
      .int()
      .min(256)
      .max(32_768)
      .default(2_400),
    FIRECRAWL_API_KEY: optionalTrimmed,
    FISH_AUDIO_API_KEY: optionalTrimmed,
    FISH_AUDIO_REFERENCE_ID: z
      .string()
      .regex(/^[a-f0-9]{32}$/i)
      .default("ca3007f96ae7499ab87d27ea3599956a"),
    FISH_AUDIO_MODEL: z
      .string()
      .regex(/^[a-z0-9._-]+$/i)
      .default("s2-pro"),
    FISH_AUDIO_MAX_CHARACTERS: z.coerce
      .number()
      .int()
      .min(100)
      .max(5_000)
      .default(600),
    OPENROUTER_API_KEY: optionalTrimmed,
    OPENROUTER_FISH_AUDIO_MODEL: z
      .string()
      .regex(/^[a-z0-9._-]+\/[a-z0-9._-]+(:free)?$/i)
      .default("google/gemini-3.1-flash-tts-preview"),
    OPENROUTER_VOICE: z
      .string()
      .min(1)
      .default("Kore"),
    MUSIC_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    LAVALINK_URL: z
      .string()
      .regex(/^[a-z0-9.-]+:\d{2,5}$/i, "must be a host:port pair")
      .default("lavalink:2333"),
    LAVALINK_PASSWORD: optionalTrimmed,
    LAVALINK_SECURE: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    MUSIC_DEFAULT_VOLUME: z.coerce.number().int().min(0).max(200).default(65),
    MUSIC_MAX_QUEUE_LENGTH: z.coerce.number().int().min(1).max(500).default(100),
    MUSIC_MAX_PLAYLIST_TRACKS: z.coerce.number().int().min(1).max(100).default(25),
    MUSIC_IDLE_TIMEOUT_SECONDS: z.coerce.number().int().min(30).max(3_600).default(120),
    DATABASE_URL: z.string().min(1),
    REDIS_URL: z.string().min(1),
    INTERACTION_MODE: z.enum(["mentions", "ambient"]).default("ambient"),
    AMBIENT_REPLY_CHANCE: z.coerce.number().min(0).max(1).default(0.65),
    AMBIENT_EVALUATION_COOLDOWN_SECONDS: z.coerce
      .number()
      .int()
      .min(5)
      .max(300)
      .default(12),
    MAX_CONCURRENT_AI_REQUESTS: z.coerce
      .number()
      .int()
      .min(1)
      .max(32)
      .default(4),
    MAX_USER_REQUESTS_PER_MINUTE: z.coerce
      .number()
      .int()
      .min(1)
      .max(120)
      .default(8),
    MAX_VISION_REQUESTS_PER_MINUTE: z.coerce
      .number()
      .int()
      .min(1)
      .max(120)
      .default(10),
    RECENT_MESSAGE_COUNT: z.coerce.number().int().min(4).max(100).default(20),
    RAG_RESULT_COUNT: z.coerce.number().int().min(1).max(30).default(8),
    SUMMARY_EVERY_MESSAGES: z.coerce
      .number()
      .int()
      .min(10)
      .max(500)
      .default(40),
    MAX_WEB_RESULTS: z.coerce.number().int().min(1).max(10).default(5),
    AGENT_ENABLED: z
      .enum(["true", "false"])
      .default("true")
      .transform((value) => value === "true"),
    DISCORD_AGENT_ACTIONS_ENABLED: z
      .enum(["true", "false"])
      .default("true")
      .transform((value) => value === "true"),
    AGENT_MAX_ITERATIONS: z.coerce
      .number()
      .int()
      .min(2)
      .max(16)
      .default(8),
    AGENT_MAX_TOOL_CALLS: z.coerce
      .number()
      .int()
      .min(1)
      .max(64)
      .default(24),
    AGENT_MAX_PARALLEL_TOOL_CALLS: z.coerce
      .number()
      .int()
      .min(1)
      .max(12)
      .default(6),
    AGENT_RUN_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(10_000)
      .max(300_000)
      .default(120_000),
    AGENT_TOOL_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(120_000)
      .default(30_000),
    MEMORY_WORKER_ENABLED: z
      .enum(["true", "false"])
      .default("true")
      .transform((value) => value === "true"),
    MEMORY_BATCH_SIZE: z.coerce.number().int().min(4).max(100).default(32),
    MEMORY_POLL_MS: z.coerce.number().int().min(100).max(10_000).default(750),
    MEMORY_STARTUP_DELAY_MS: z.coerce
      .number()
      .int()
      .min(0)
      .max(300_000)
      .default(15_000),
    MEMORY_SUCCESS_INTERVAL_MS: z.coerce
      .number()
      .int()
      .min(5_000)
      .max(300_000)
      .default(30_000),
    MEMORY_RECALL_COUNT: z.coerce.number().int().min(4).max(30).default(12),
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
      .default("info"),
    HEALTH_PORT: z.coerce.number().int().min(1_024).max(65_535).default(3_000),
  })
  .superRefine((value, context) => {
    const localHosts = new Set([
      "localhost",
      "127.0.0.1",
      "::1",
      "host.docker.internal",
    ]);
    for (const [field, input] of [
      ["TEXT_API_URL", value.TEXT_API_URL],
      ["OPENAI_BASE_URL", value.OPENAI_BASE_URL],
      ...(value.EMBEDDING_API_URL
        ? ([["EMBEDDING_API_URL", value.EMBEDDING_API_URL]] as const)
        : []),
    ] as const) {
      const url = new URL(input);
      if (url.protocol !== "https:" && !localHosts.has(url.hostname)) {
        context.addIssue({
          code: "custom",
          path: [field],
          message: "must use HTTPS unless it targets a local host",
        });
      }
    }
    const embeddingFields = [
      value.EMBEDDING_API_URL,
      value.EMBEDDING_API_KEY,
      value.EMBEDDING_MODEL,
    ];
    const configuredEmbeddingFields = embeddingFields.filter(Boolean).length;
    if (
      configuredEmbeddingFields !== 0 &&
      configuredEmbeddingFields !== embeddingFields.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["EMBEDDING_API_URL"],
        message:
          "EMBEDDING_API_URL, EMBEDDING_API_KEY, and EMBEDDING_MODEL must be configured together",
      });
    }
    if (value.MUSIC_ENABLED && !value.LAVALINK_PASSWORD) {
      context.addIssue({
        code: "custom",
        path: ["LAVALINK_PASSWORD"],
        message: "is required when MUSIC_ENABLED=true",
      });
    }
  });

export interface AppConfig {
  nodeEnv: "development" | "test" | "production";
  discordToken?: string;
  guildIds: readonly string[];
  ownerUserIds: readonly string[];
  text: {
    endpoint: string;
    apiKey: string;
    model: string;
    maxTokens: number;
    summaryMaxTokens: number;
    memoryMaxTokens: number;
    reasoningEffort: "none" | "low" | "medium" | "high" | "max" | "xhigh";
  };
  embedding?: {
    endpoint: string;
    apiKey: string;
    model: string;
    dimensions: 1024;
    batchSize: number;
  };
  cloudflare: {
    accountId: string;
    apiToken: string;
    voiceFallback: boolean;
    voiceModel: string;
    voiceSpeaker: string;
    sttModel: string;
  };
  voiceChat: {
    enabled: boolean;
    language: string;
    maxUtteranceSeconds: number;
    idleTimeoutSeconds: number;
    maxReplyCharacters: number;
  };
  openAI: {
    baseUrl: string;
    apiKey: string;
    visionModel: string;
    maxTokens: number;
  };
  firecrawlApiKey?: string;
  fishAudio: {
    apiKey?: string;
    referenceId: string;
    model: string;
    maxCharacters: number;
  };
  openRouterFishAudio: {
    apiKey?: string;
    referenceId: string;
    model: string;
    voice: string;
    maxCharacters: number;
  };
  music: {
    enabled: boolean;
    lavalinkUrl: string;
    lavalinkPassword?: string;
    lavalinkSecure: boolean;
    defaultVolume: number;
    maxQueueLength: number;
    maxPlaylistTracks: number;
    idleTimeoutSeconds: number;
  };
  databaseUrl: string;
  redisUrl: string;
  interactionMode: "mentions" | "ambient";
  ambientReplyChance: number;
  ambientEvaluationCooldownSeconds: number;
  maxConcurrentAIRequests: number;
  maxUserRequestsPerMinute: number;
  maxVisionRequestsPerMinute: number;
  recentMessageCount: number;
  ragResultCount: number;
  summaryEveryMessages: number;
  maxWebResults: number;
  agent: {
    enabled: boolean;
    discordActionsEnabled: boolean;
    maxIterations: number;
    maxToolCalls: number;
    maxParallelToolCalls: number;
    runTimeoutMs: number;
    toolTimeoutMs: number;
  };
  memory: {
    workerEnabled: boolean;
    batchSize: number;
    pollMs: number;
    startupDelayMs: number;
    successIntervalMs: number;
    recallCount: number;
  };
  logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";
  healthPort: number;
}

export function loadConfig(
  environment: Record<string, string | undefined> = process.env,
): AppConfig {
  const value = configSchema.parse(environment);

  return {
    nodeEnv: value.NODE_ENV,
    ...(value.DISCORD_TOKEN ? { discordToken: value.DISCORD_TOKEN } : {}),
    guildIds: value.DISCORD_GUILD_ID
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
    ownerUserIds: value.BOT_OWNER_USER_IDS
      ? [...new Set(value.BOT_OWNER_USER_IDS.split(",").map((id) => id.trim()))]
      : [],
    text: {
      endpoint: normalizeChatCompletionsUrl(value.TEXT_API_URL),
      apiKey: value.TEXT_API_KEY,
      model: value.TEXT_MODEL,
      maxTokens: value.TEXT_MAX_TOKENS,
      summaryMaxTokens: value.SUMMARY_MAX_TOKENS,
      memoryMaxTokens: value.MEMORY_MAX_TOKENS,
      reasoningEffort: value.TEXT_REASONING_EFFORT,
    },
    ...(value.EMBEDDING_API_URL &&
    value.EMBEDDING_API_KEY &&
    value.EMBEDDING_MODEL
      ? {
          embedding: {
            endpoint: normalizeEmbeddingsUrl(value.EMBEDDING_API_URL),
            apiKey: value.EMBEDDING_API_KEY,
            model: value.EMBEDDING_MODEL,
            dimensions: value.EMBEDDING_DIMENSIONS as 1024,
            batchSize: value.EMBEDDING_BATCH_SIZE,
          },
        }
      : {}),
    cloudflare: {
      accountId: value.CLOUDFLARE_ACCOUNT_ID,
      apiToken: value.CLOUDFLARE_API_TOKEN,
      voiceFallback: value.CLOUDFLARE_VOICE_FALLBACK,
      voiceModel: value.CLOUDFLARE_VOICE_MODEL,
      voiceSpeaker: value.CLOUDFLARE_VOICE_SPEAKER,
      sttModel: value.CLOUDFLARE_STT_MODEL,
    },
    voiceChat: {
      enabled: value.VOICE_CHAT_ENABLED,
      language: value.VOICE_CHAT_LANGUAGE.toLowerCase(),
      maxUtteranceSeconds: value.VOICE_CHAT_MAX_UTTERANCE_SECONDS,
      idleTimeoutSeconds: value.VOICE_CHAT_IDLE_TIMEOUT_SECONDS,
      maxReplyCharacters: value.VOICE_CHAT_MAX_REPLY_CHARACTERS,
    },
    openAI: {
      baseUrl: normalizeChatCompletionsUrl(value.OPENAI_BASE_URL),
      apiKey: value.OPENAI_API_KEY,
      visionModel: value.OPENAI_VISION_MODEL,
      maxTokens: value.OPENAI_MAX_TOKENS,
    },
    ...(value.FIRECRAWL_API_KEY
      ? { firecrawlApiKey: value.FIRECRAWL_API_KEY }
      : {}),
    fishAudio: {
      ...(value.FISH_AUDIO_API_KEY ? { apiKey: value.FISH_AUDIO_API_KEY } : {}),
      referenceId: value.FISH_AUDIO_REFERENCE_ID,
      model: value.FISH_AUDIO_MODEL,
      maxCharacters: value.FISH_AUDIO_MAX_CHARACTERS,
    },
    openRouterFishAudio: {
      ...(value.OPENROUTER_API_KEY ? { apiKey: value.OPENROUTER_API_KEY } : {}),
      referenceId: value.FISH_AUDIO_REFERENCE_ID,
      model: value.OPENROUTER_FISH_AUDIO_MODEL,
      voice: value.OPENROUTER_VOICE,
      maxCharacters: value.FISH_AUDIO_MAX_CHARACTERS,
    },
    music: {
      enabled: value.MUSIC_ENABLED,
      lavalinkUrl: value.LAVALINK_URL,
      ...(value.LAVALINK_PASSWORD
        ? { lavalinkPassword: value.LAVALINK_PASSWORD }
        : {}),
      lavalinkSecure: value.LAVALINK_SECURE,
      defaultVolume: value.MUSIC_DEFAULT_VOLUME,
      maxQueueLength: value.MUSIC_MAX_QUEUE_LENGTH,
      maxPlaylistTracks: value.MUSIC_MAX_PLAYLIST_TRACKS,
      idleTimeoutSeconds: value.MUSIC_IDLE_TIMEOUT_SECONDS,
    },
    databaseUrl: value.DATABASE_URL,
    redisUrl: value.REDIS_URL,
    interactionMode: value.INTERACTION_MODE,
    ambientReplyChance: value.AMBIENT_REPLY_CHANCE,
    ambientEvaluationCooldownSeconds: value.AMBIENT_EVALUATION_COOLDOWN_SECONDS,
    maxConcurrentAIRequests: value.MAX_CONCURRENT_AI_REQUESTS,
    maxUserRequestsPerMinute: value.MAX_USER_REQUESTS_PER_MINUTE,
    maxVisionRequestsPerMinute: value.MAX_VISION_REQUESTS_PER_MINUTE,
    recentMessageCount: value.RECENT_MESSAGE_COUNT,
    ragResultCount: value.RAG_RESULT_COUNT,
    summaryEveryMessages: value.SUMMARY_EVERY_MESSAGES,
    maxWebResults: value.MAX_WEB_RESULTS,
    agent: {
      enabled: value.AGENT_ENABLED,
      discordActionsEnabled: value.DISCORD_AGENT_ACTIONS_ENABLED,
      maxIterations: value.AGENT_MAX_ITERATIONS,
      maxToolCalls: value.AGENT_MAX_TOOL_CALLS,
      maxParallelToolCalls: value.AGENT_MAX_PARALLEL_TOOL_CALLS,
      runTimeoutMs: value.AGENT_RUN_TIMEOUT_MS,
      toolTimeoutMs: value.AGENT_TOOL_TIMEOUT_MS,
    },
    memory: {
      workerEnabled: value.MEMORY_WORKER_ENABLED,
      batchSize: value.MEMORY_BATCH_SIZE,
      pollMs: value.MEMORY_POLL_MS,
      startupDelayMs: value.MEMORY_STARTUP_DELAY_MS,
      successIntervalMs: value.MEMORY_SUCCESS_INTERVAL_MS,
      recallCount: value.MEMORY_RECALL_COUNT,
    },
    logLevel: value.LOG_LEVEL,
    healthPort: value.HEALTH_PORT,
  };
}

export function normalizeChatCompletionsUrl(input: string): string {
  const url = new URL(input);
  url.pathname = url.pathname.replace(/\/+$/, "");
  if (!url.pathname.endsWith("/chat/completions")) {
    url.pathname = `${url.pathname}/chat/completions`.replace(/\/{2,}/g, "/");
  }
  return url.toString();
}

export function normalizeEmbeddingsUrl(input: string): string {
  const url = new URL(input);
  url.pathname = url.pathname.replace(/\/+$/, "");
  if (url.pathname.endsWith("/chat/completions")) {
    url.pathname = url.pathname.replace(/\/chat\/completions$/, "/embeddings");
  } else if (!url.pathname.endsWith("/embeddings")) {
    url.pathname = `${url.pathname}/embeddings`.replace(/\/{2,}/g, "/");
  }
  return url.toString();
}
