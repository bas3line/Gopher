import { AIClient } from "./ai/client.ts";
import { loadConfig } from "./config.ts";
import { createDatabasePool } from "./db/pool.ts";
import { migrate } from "./db/migrate.ts";
import { DiscordBot } from "./discord/bot.ts";
import { startHealthServer } from "./health.ts";
import { Coordinator } from "./infra/coordinator.ts";
import { createLogger } from "./logger.ts";
import { MemoryStore } from "./memory/store.ts";
import { MusicStore } from "./music/store.ts";
import { CloudflareAuraVoice } from "./voice/cloudflare-aura.ts";
import { CloudflareWhisper } from "./voice/cloudflare-whisper.ts";
import { FallbackVoice } from "./voice/fallback.ts";
import { FishAudioVoice } from "./voice/fish-audio.ts";
import { WebResearch } from "./web/firecrawl.ts";

const config = loadConfig();
const logger = createLogger(config);

if (!config.discordToken) {
  logger.fatal(
    "DISCORD_TOKEN is missing. Create a bot in the Discord Developer Portal and set the token in .env.",
  );
  process.exit(1);
}

const pool = createDatabasePool(config.databaseUrl, logger);
const coordinator = new Coordinator(config.redisUrl);
const memory = new MemoryStore(pool);
const musicStore = new MusicStore(pool, config.music.defaultVolume);
const textAI = new AIClient({
  endpoint: config.text.endpoint,
  apiKey: config.text.apiKey,
  maxTokens: config.text.maxTokens,
  reasoningEffort: config.text.reasoningEffort,
  logger,
});
const summaryAI = new AIClient({
  endpoint: config.text.endpoint,
  apiKey: config.text.apiKey,
  maxTokens: config.text.summaryMaxTokens,
  reasoningEffort: config.text.reasoningEffort,
  logger,
});
const visionAI = new AIClient({
  endpoint: config.openAI.baseUrl,
  apiKey: config.openAI.apiKey,
  maxTokens: config.openAI.maxTokens,
  logger,
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
  primary: fishVoice,
  fallback: cloudflareVoice,
  primaryName: "Fish Audio",
  fallbackName: "Cloudflare Aura-2 Amalthea",
  logger,
});
const bot = new DiscordBot({
  config,
  textAI,
  summaryAI,
  visionAI,
  memory,
  musicStore,
  coordinator,
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
}

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "shutting down");
  healthServer?.stop(true);
  await bot.stop();
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
  await Promise.allSettled([coordinator.close(), pool.end()]);
  process.exit(1);
}
