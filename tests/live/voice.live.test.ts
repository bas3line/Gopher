import { expect, test } from "bun:test";
import pino from "pino";
import { FishAudioVoice } from "../../src/voice/fish-audio.ts";

const enabled = process.env.RUN_LIVE_VOICE_TEST === "1";

test.skipIf(!enabled)(
  "live Fish Audio returns Discord-compatible Ogg Opus",
  async () => {
    const apiKey = process.env.FISH_AUDIO_API_KEY;
    if (!apiKey) throw new Error("FISH_AUDIO_API_KEY is missing");

    const voice = await new FishAudioVoice({
      apiKey,
      referenceId:
        process.env.FISH_AUDIO_REFERENCE_ID ??
        "ca3007f96ae7499ab87d27ea3599956a",
      model: process.env.FISH_AUDIO_MODEL ?? "s2-pro",
      maxCharacters: 1_800,
      logger: pino({ level: "silent" }),
      maxRetries: 1,
    }).synthesize("voice smoke test passed");

    expect(voice.audio.subarray(0, 4).toString("ascii")).toBe("OggS");
    expect(voice.durationSeconds).toBeGreaterThan(0);
    expect(Buffer.from(voice.waveform, "base64").length).toBeGreaterThan(0);
  },
  120_000,
);
