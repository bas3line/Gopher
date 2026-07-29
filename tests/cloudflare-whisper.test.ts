import { describe, expect, test } from "bun:test";
import pino from "pino";
import { pcmToWav } from "../src/voice/audio.ts";
import {
  CloudflareWhisper,
  SpeechToTextError,
} from "../src/voice/cloudflare-whisper.ts";

describe("Cloudflare Whisper speech-to-text", () => {
  test("sends bounded PCM WAV as base64 to Whisper Turbo", async () => {
    const wav = pcmToWav(Buffer.alloc(48_000 * 2 * 2));
    let request: Request | undefined;
    const whisper = new CloudflareWhisper({
      accountId: "0123456789abcdef0123456789abcdef",
      apiToken: "cloudflare-test-token",
      model: "@cf/openai/whisper-large-v3-turbo",
      language: "en",
      enabled: true,
      logger: pino({ level: "silent" }),
      maxRetries: 0,
      fetchImpl: async (input, init) => {
        request = new Request(input, init);
        return Response.json({ success: true, result: { text: "hello gopher" } });
      },
    });

    await expect(whisper.transcribe(wav)).resolves.toBe("hello gopher");
    expect(request?.url).toBe(
      "https://api.cloudflare.com/client/v4/accounts/0123456789abcdef0123456789abcdef/ai/run/@cf/openai/whisper-large-v3-turbo",
    );
    expect(request?.headers.get("authorization")).toBe(
      "Bearer cloudflare-test-token",
    );
    expect(await request?.json()).toEqual({
      audio: wav.toString("base64"),
      task: "transcribe",
      language: "en",
      vad_filter: true,
      condition_on_previous_text: false,
      no_speech_threshold: 0.75,
      compression_ratio_threshold: 2.4,
    });
  });

  test("rejects unsupported or oversized input before sending audio", async () => {
    const whisper = new CloudflareWhisper({
      accountId: "0123456789abcdef0123456789abcdef",
      apiToken: "cloudflare-test-token",
      model: "@cf/openai/whisper-large-v3-turbo",
      language: "en",
      enabled: true,
      logger: pino({ level: "silent" }),
      maxAudioBytes: 44,
    });
    await expect(whisper.transcribe(Buffer.from("not audio"))).rejects.toBeInstanceOf(
      SpeechToTextError,
    );
    await expect(
      whisper.transcribe(pcmToWav(Buffer.alloc(48_000 * 2 * 2))),
    ).rejects.toBeInstanceOf(SpeechToTextError);
  });
});
