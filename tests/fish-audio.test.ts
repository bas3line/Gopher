import { describe, expect, test } from "bun:test";
import pino from "pino";
import {
  createDiscordWaveform,
  FishAudioVoice,
  prepareSpeechText,
  readOggOpusDurationSeconds,
  VoiceSynthesisError,
} from "../src/voice/fish-audio.ts";

function oggOpusFixture(durationSeconds = 2): Buffer {
  const opusHead = Buffer.alloc(19);
  opusHead.write("OpusHead", 0, "ascii");
  opusHead[8] = 1;
  opusHead[9] = 1;
  opusHead.writeUInt16LE(312, 10);

  const page = Buffer.alloc(27 + 1 + opusHead.length);
  page.write("OggS", 0, "ascii");
  page[4] = 0;
  page[5] = 2;
  page.writeBigUInt64LE(BigInt(Math.round(durationSeconds * 48_000) + 312), 6);
  page[26] = 1;
  page[27] = opusHead.length;
  opusHead.copy(page, 28);
  return page;
}

describe("Fish Audio voice synthesis", () => {
  test("prepares markdown for speech and keeps a text follow-up when needed", () => {
    const prepared = prepareSpeechText(
      "Use `go test`.\n```go\nfunc main() {}\n```\nSee https://go.dev.",
      1_800,
    );
    expect(prepared.text).toContain("Use go test.");
    expect(prepared.text).toContain(
      "I included the code in the text follow-up.",
    );
    expect(prepared.text).not.toContain("https://");
    expect(prepared.needsTextFollowUp).toBeTrue();
  });

  test("reads Opus duration and makes a bounded Discord waveform", () => {
    const audio = oggOpusFixture(2);
    expect(readOggOpusDurationSeconds(audio)).toBe(2);
    const waveform = Buffer.from(createDiscordWaveform(audio, 2), "base64");
    expect(waveform.length).toBe(20);
    expect([...waveform].every((sample) => sample > 0)).toBeTrue();
  });

  test("sends the documented E-Girl reference as an Ogg Opus request", async () => {
    const audio = oggOpusFixture(1.5);
    let request: Request | undefined;
    const client = new FishAudioVoice({
      apiKey: "fish-test-key",
      referenceId: "ca3007f96ae7499ab87d27ea3599956a",
      model: "s2-pro",
      maxCharacters: 1_800,
      logger: pino({ level: "silent" }),
      maxRetries: 0,
      fetchImpl: async (input, init) => {
        request = new Request(input, init);
        const body = audio.buffer.slice(
          audio.byteOffset,
          audio.byteOffset + audio.byteLength,
        ) as ArrayBuffer;
        return new Response(body, {
          status: 200,
          headers: { "content-type": "audio/ogg" },
        });
      },
    });

    const voice = await client.synthesize("hello from gopher");
    expect(request?.url).toBe("https://api.fish.audio/v1/tts");
    expect(request?.headers.get("authorization")).toBe("Bearer fish-test-key");
    expect(request?.headers.get("model")).toBe("s2-pro");
    expect(await request?.json()).toEqual({
      text: "hello from gopher",
      reference_id: "ca3007f96ae7499ab87d27ea3599956a",
      format: "opus",
      sample_rate: 48_000,
      opus_bitrate: 32_000,
      latency: "balanced",
      normalize: true,
    });
    expect(voice.durationSeconds).toBe(1.5);
    expect(voice.audio).toEqual(audio);
  });

  test("stays disabled without an API key", async () => {
    const client = new FishAudioVoice({
      referenceId: "ca3007f96ae7499ab87d27ea3599956a",
      model: "s2-pro",
      maxCharacters: 1_800,
      logger: pino({ level: "silent" }),
    });
    expect(client.enabled).toBeFalse();
    expect(client.synthesize("hello")).rejects.toBeInstanceOf(
      VoiceSynthesisError,
    );
  });
});
