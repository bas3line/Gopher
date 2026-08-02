import { AIClient } from "./ai/client.ts";
import { OpenAIEmbeddingClient } from "./ai/embeddings.ts";
import { loadConfig } from "./config.ts";
import { createDatabasePool } from "./db/pool.ts";
import { migrate } from "./db/migrate.ts";
import { DiscordBot } from "./discord/bot.ts";
import {
  initAllowlist,
  loadDbAllowlist,
} from "./discord/guild-allowlist.ts";
import { createDiscordLogStream } from "./discord/webhook-logger.ts";
import { startHealthServer } from "./health.ts";
import { Coordinator, Semaphore } from "./infra/coordinator.ts";
import { createLogger } from "./logger.ts";
import { MemoryStore } from "./memory/store.ts";
import { MemoryExtractor } from "./memory/extractor.ts";
import { MemoryEmbeddingWorker } from "./memory/embedding-worker.ts";
import { MemoryWorker } from "./memory/worker.ts";
import { MusicStore } from "./music/store.ts";
import { CloudflareAuraVoice } from "./voice/cloudflare-aura.ts";
import { CloudflareWhisper } from "./voice/cloudflare-whisper.ts";
import { FallbackVoice } from "./voice/fallback.ts";
import { FishAudioVoice } from "./voice/fish-audio.ts";
import { OpenRouterFishVoice } from "./voice/openrouter-fish.ts";
import { WebResearch } from "./web/firecrawl.ts";

const config = loadConfig();

function parseWebhookUrls(raw?: string) {
  if (!raw) return [];
  return raw.split(",").map((pair) => {
    const eqIdx = pair.indexOf("=");
    if (eqIdx < 1) return null;
    return {
      name: pair.slice(0, eqIdx).trim(),
      webhookUrl: pair.slice(eqIdx + 1).trim(),
    };
  }).filter((entry): entry is { name: string; webhookUrl: string } =>
    entry !== null && entry.webhookUrl.length > 0,
  );
}

const webhookUrls = parseWebhookUrls(process.env.WEBHOOK_URLS);
const extraStreams: Array<{ write: (s: string) => void }> = [];
if (webhookUrls.length > 0) {
  extraStreams.push(createDiscordLogStream(webhookUrls));
}

const logger = createLogger(config, extraStreams as unknown as Array<import("node:stream").Writable>);

if (webhookUrls.length > 0) {
  logger.info({ channels: webhookUrls.map((w) => w.name) }, "discord webhook logging enabled");
}

if (!config.discordToken) {
  logger.fatal(
    "DISCORD_TOKEN is missing. Create a bot in the Discord Developer Portal and set the token in .env.",
  );
  process.exit(1);
}

const pool = createDatabasePool(config.databaseUrl, logger);
const coordinator = new Coordinator(config.redisUrl);
const aiSemaphore = new Semaphore(config.maxConcurrentAIRequests);
const embeddingAI = config.embedding
  ? new OpenAIEmbeddingClient({
      ...config.embedding,
      logger,
    })
  : undefined;
const memory = new MemoryStore(pool, {
  ...(embeddingAI ? { embedding: embeddingAI } : {}),
  logger,
});
const musicStore = new MusicStore(pool, config.music.defaultVolume);
const textAI = new AIClient({
  endpoint: config.text.endpoint,
  apiKey: config.text.apiKey,
  maxTokens: config.text.maxTokens,
  reasoningEffort: config.text.reasoningEffort,
  logger: logger.child({ aiWorkload: "foreground" }),
  maxRetries: 4,
  retryBaseDelayMs: 2_000,
  maxRetryDelayMs: 30_000,
});
const summaryAI = new AIClient({
  endpoint: config.text.endpoint,
  apiKey: config.text.apiKey,
  maxTokens: config.text.summaryMaxTokens,
  reasoningEffort: config.text.reasoningEffort,
  temperature: 0.2,
  acceptTruncatedOutput: true,
  logger: logger.child({ aiWorkload: "summary" }),
  maxRetries: 1,
});
const memoryAI = new AIClient({
  endpoint: config.text.endpoint,
  apiKey: config.text.apiKey,
  maxTokens: config.text.memoryMaxTokens,
  reasoningEffort: config.text.reasoningEffort,
  temperature: 0.1,
  logger: logger.child({ aiWorkload: "memory" }),
  maxRetries: 0,
});
const visionAI = new AIClient({
  endpoint: config.openAI.baseUrl,
  apiKey: config.openAI.apiKey,
  maxTokens: config.openAI.maxTokens,
  logger: logger.child({ aiWorkload: "vision" }),
});
const web = new WebResearch(
  config.firecrawlApiKey,
  config.maxWebResults,
  logger,
);
const fishVoice = new FishAudioVoice({
  ...config.fishAudio,
  logger,
});
const openRouterVoice = new OpenRouterFishVoice({
  ...config.openRouterFishAudio,
  logger,
});
const cloudflareVoice = new CloudflareAuraVoice({
  accountId: config.cloudflare.accountId,
  apiToken: config.cloudflare.apiToken,
  model: config.cloudflare.voiceModel,
  speaker: config.cloudflare.voiceSpeaker,
  maxCharacters: config.fishAudio.maxCharacters,
  enabled: config.cloudflare.voiceFallback,
  logger,
});
const voiceChatStt = new CloudflareWhisper({
  accountId: config.cloudflare.accountId,
  apiToken: config.cloudflare.apiToken,
  model: config.cloudflare.sttModel,
  language: config.voiceChat.language,
  enabled: config.voiceChat.enabled,
  logger,
});
const voiceChatVoice = new CloudflareAuraVoice({
  accountId: config.cloudflare.accountId,
  apiToken: config.cloudflare.apiToken,
  model: config.cloudflare.voiceModel,
  speaker: config.cloudflare.voiceSpeaker,
  maxCharacters: config.voiceChat.maxReplyCharacters,
  enabled: config.voiceChat.enabled,
  logger,
});
const voice = new FallbackVoice({
  primary: openRouterVoice,
  fallback: cloudflareVoice,
  primaryName: "OpenRouter Fish Audio (free)",
  fallbackName: "Cloudflare Aura-2 Amalthea",
  logger,
});
const memoryWorker = new MemoryWorker({
  store: memory,
  extractor: new MemoryExtractor({
    client: memoryAI,
    model: config.text.model,
  }),
  model: config.text.model,
  logger,
  semaphore: aiSemaphore,
  batchSize: config.memory.batchSize,
  idlePollMs: config.memory.pollMs,
  startupDelayMs: config.memory.startupDelayMs,
  successIntervalMs: config.memory.successIntervalMs,
});
const memoryEmbeddingWorker = embeddingAI
  ? new MemoryEmbeddingWorker({
      store: memory,
      embedding: embeddingAI,
      logger,
      batchSize: config.embedding!.batchSize,
      idlePollMs: config.memory.pollMs,
    })
  : undefined;
const bot = new DiscordBot({
  config,
  textAI,
  summaryAI,
  visionAI,
  memory,
  musicStore,
  coordinator,
  semaphore: aiSemaphore,
  web,
  voice,
  voiceChatStt,
  voiceChatVoice,
  logger,
});

let healthServer: Bun.Server<undefined> | undefined;
let shuttingDown = false;

async function start(): Promise<void> {
  await migrate(pool);
  logger.info("database migrations complete");
  initAllowlist(pool, config.guildIds as string[]);
  await loadDbAllowlist();
  await coordinator.connect();
  logger.info("Redis coordination ready");
  await bot.start(config.discordToken!);
  healthServer = startHealthServer({
    port: config.healthPort,
    pool,
    coordinator,
    discordReady: () => bot.ready,
    logger,
  });
  if (config.memory.workerEnabled) {
    memoryWorker.start();
    logger.info(
      {
        startupDelayMs: config.memory.startupDelayMs,
        successIntervalMs: config.memory.successIntervalMs,
      },
      "durable memory consolidation worker started",
    );
  }
  if (memoryEmbeddingWorker) {
    memoryEmbeddingWorker.start();
    logger.info(
      { model: embeddingAI?.model, dimensions: embeddingAI?.dimensions },
      "semantic memory embedding worker started",
    );
  }
}

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "shutting down");
  healthServer?.stop(true);
  await bot.stop();
  await Promise.all([
    memoryWorker.stop(),
    memoryEmbeddingWorker?.stop() ?? Promise.resolve(),
  ]);
  await Promise.allSettled([coordinator.close(), pool.end()]);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void shutdown(signal).finally(() => process.exit(0));
  });
}

try {
  await start();
} catch (error) {
  logger.fatal({ err: error }, "startup failed");
  await Promise.all([
    memoryWorker.stop(),
    memoryEmbeddingWorker?.stop() ?? Promise.resolve(),
  ]);
  await Promise.allSettled([coordinator.close(), pool.end()]);
  process.exit(1);
}
