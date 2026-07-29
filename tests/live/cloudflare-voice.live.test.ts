import { expect, test } from "bun:test";
import pino from "pino";
import { CloudflareAuraVoice } from "../../src/voice/cloudflare-aura.ts";

const runLive = process.env.RUN_LIVE_CLOUDFLARE_VOICE_TEST === "1";

test.skipIf(!runLive)(
  "live Cloudflare Aura-2 Amalthea returns Discord-compatible Ogg Opus",
  async () => {
    const voice = new CloudflareAuraVoice({
      accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? "",
      apiToken: process.env.CLOUDFLARE_API_TOKEN ?? "",
      model: process.env.CLOUDFLARE_VOICE_MODEL ?? "@cf/deepgram/aura-2-en",
      speaker: process.env.CLOUDFLARE_VOICE_SPEAKER ?? "amalthea",
      maxCharacters: 1_800,
      enabled: true,
      logger: pino({ level: "silent" }),
      maxRetries: 0,
    });

    const result = await voice.synthesize("Gopher voice fallback is working.");
    expect(result.audio.subarray(0, 4).toString("ascii")).toBe("OggS");
    expect(result.durationSeconds).toBeGreaterThan(0);
    expect(result.waveform.length).toBeGreaterThan(0);
  },
  60_000,
);
