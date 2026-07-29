import { describe, expect, test } from "bun:test";
import pino from "pino";
import { FallbackVoice } from "../src/voice/fallback.ts";
import {
  type SynthesizedVoiceMessage,
  type VoiceSynthesizer,
  VoiceSynthesisError,
} from "../src/voice/fish-audio.ts";

const result: SynthesizedVoiceMessage = {
  audio: Buffer.from("OggS fallback"),
  durationSeconds: 1,
  waveform: "AQ==",
  needsTextFollowUp: false,
};

function provider(
  enabled: boolean,
  synthesize: (text: string) => Promise<SynthesizedVoiceMessage>,
): VoiceSynthesizer {
  return { enabled, synthesize };
}

describe("Fish-first voice fallback", () => {
  test("uses Fish when the primary provider succeeds", async () => {
    let fallbackCalls = 0;
    const voice = new FallbackVoice({
      primary: provider(true, async () => result),
      fallback: provider(true, async () => {
        fallbackCalls += 1;
        return result;
      }),
      primaryName: "Fish Audio",
      fallbackName: "Cloudflare Aura-2 Amalthea",
      logger: pino({ level: "silent" }),
    });

    expect(await voice.synthesize("hello")).toBe(result);
    expect(fallbackCalls).toBe(0);
  });

  test("uses Aura-2 Amalthea after Fish fails", async () => {
    let fallbackText = "";
    const voice = new FallbackVoice({
      primary: provider(true, async () => {
        throw new VoiceSynthesisError("Fish Audio returned HTTP 402", false);
      }),
      fallback: provider(true, async (text) => {
        fallbackText = text;
        return result;
      }),
      primaryName: "Fish Audio",
      fallbackName: "Cloudflare Aura-2 Amalthea",
      logger: pino({ level: "silent" }),
    });

    expect(await voice.synthesize("speak this")).toBe(result);
    expect(fallbackText).toBe("speak this");
  });
});
