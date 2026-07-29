import { describe, expect, test } from "bun:test";
import pino from "pino";
import { CloudflareAuraVoice } from "../src/voice/cloudflare-aura.ts";

function oggOpusFixture(durationSeconds = 1.25): Buffer {
  const opusHead = Buffer.alloc(19);
  opusHead.write("OpusHead", 0, "ascii");
  opusHead[8] = 1;
  opusHead[9] = 1;
  opusHead.writeUInt16LE(312, 10);

  const page = Buffer.alloc(27 + 1 + opusHead.length);
  page.write("OggS", 0, "ascii");
  page[5] = 2;
  page.writeBigUInt64LE(BigInt(Math.round(durationSeconds * 48_000) + 312), 6);
  page[26] = 1;
  page[27] = opusHead.length;
  opusHead.copy(page, 28);
  return page;
}

describe("Cloudflare Aura-2 voice fallback", () => {
  test("requests Filipino-English Amalthea as a directly usable Ogg Opus response", async () => {
    const audio = oggOpusFixture();
    let request: Request | undefined;
    const voice = new CloudflareAuraVoice({
      accountId: "0123456789abcdef0123456789abcdef",
      apiToken: "cloudflare-test-token",
      model: "@cf/deepgram/aura-2-en",
      speaker: "amalthea",
      maxCharacters: 1_800,
      enabled: true,
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
          headers: { "content-type": "audio/mpeg" },
        });
      },
    });

    const result = await voice.synthesize("hello from the fallback");
    expect(request?.url).toBe(
      "https://api.cloudflare.com/client/v4/accounts/0123456789abcdef0123456789abcdef/ai/run/@cf/deepgram/aura-2-en",
    );
    expect(request?.headers.get("authorization")).toBe(
      "Bearer cloudflare-test-token",
    );
    expect(await request?.json()).toEqual({
      text: "hello from the fallback",
      speaker: "amalthea",
      encoding: "opus",
      container: "ogg",
    });
    expect(result.audio).toEqual(audio);
    expect(result.durationSeconds).toBe(1.25);
    expect(result.waveform).not.toBeEmpty();
  });
});
