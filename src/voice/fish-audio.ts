import type { Logger } from "../logger.ts";

const fishAudioEndpoint = "https://api.fish.audio/v1/tts";
const opusSampleRate = 48_000;
const defaultMaxAudioBytes = 8 * 1024 * 1024;

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface SynthesizedVoiceMessage {
  audio: Buffer;
  durationSeconds: number;
  waveform: string;
  needsTextFollowUp: boolean;
}

export interface VoiceSynthesizer {
  readonly enabled: boolean;
  synthesize(text: string): Promise<SynthesizedVoiceMessage>;
}

export class VoiceSynthesisError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = "VoiceSynthesisError";
  }
}

export class FishAudioVoice implements VoiceSynthesizer {
  constructor(
    private readonly options: {
      apiKey?: string;
      referenceId: string;
      model: string;
      maxCharacters: number;
      logger: Logger;
      fetchImpl?: FetchLike;
      timeoutMs?: number;
      maxRetries?: number;
      maxAudioBytes?: number;
    },
  ) {}

  get enabled(): boolean {
    return Boolean(this.options.apiKey);
  }

  async synthesize(input: string): Promise<SynthesizedVoiceMessage> {
    if (!this.options.apiKey) {
      throw new VoiceSynthesisError("Fish Audio is not configured", false);
    }

    const prepared = prepareSpeechText(input, this.options.maxCharacters);
    if (!prepared.text) {
      throw new VoiceSynthesisError("The answer had no speakable text", false);
    }

    const maxRetries = this.options.maxRetries ?? 2;
    let lastError: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      try {
        const audio = await this.request(prepared.text);
        const durationSeconds = readOggOpusDurationSeconds(audio);
        return {
          audio,
          durationSeconds,
          waveform: createDiscordWaveform(audio, durationSeconds),
          needsTextFollowUp: prepared.needsTextFollowUp,
        };
      } catch (error) {
        lastError = error;
        const retryable =
          error instanceof VoiceSynthesisError && error.retryable;
        if (!retryable || attempt === maxRetries) throw error;
        await Bun.sleep(400 * 2 ** attempt + Math.floor(Math.random() * 150));
      }
    }

    throw lastError;
  }

  private async request(text: string): Promise<Buffer> {
    const fetchImpl = this.options.fetchImpl ?? fetch;
    let response: Response;
    try {
      response = await fetchImpl(fishAudioEndpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.options.apiKey}`,
          "content-type": "application/json",
          accept: "audio/ogg, application/octet-stream",
          model: this.options.model,
        },
        body: JSON.stringify({
          text,
          reference_id: this.options.referenceId,
          format: "opus",
          sample_rate: opusSampleRate,
          opus_bitrate: 32_000,
          latency: "balanced",
          normalize: true,
        }),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 90_000),
        redirect: "error",
      });
    } catch (error) {
      const retryable =
        error instanceof TypeError ||
        (error instanceof DOMException && error.name === "TimeoutError");
      throw new VoiceSynthesisError(
        retryable
          ? "Fish Audio timed out or could not be reached"
          : "Fish Audio request failed",
        retryable,
      );
    }

    const requestId = response.headers.get("x-request-id") ?? undefined;
    if (!response.ok) {
      const retryable =
        response.status === 408 ||
        response.status === 429 ||
        response.status >= 500;
      this.options.logger.warn(
        { status: response.status, requestId, retryable },
        "Fish Audio returned an error",
      );
      await response.body?.cancel();
      throw new VoiceSynthesisError(
        `Fish Audio returned HTTP ${response.status}${requestId ? ` (request ${requestId})` : ""}`,
        retryable,
      );
    }

    const audio = await readBoundedResponse(
      response,
      this.options.maxAudioBytes ?? defaultMaxAudioBytes,
    );
    if (
      audio.length < 32 ||
      audio.subarray(0, 4).toString("ascii") !== "OggS"
    ) {
      throw new VoiceSynthesisError(
        "Fish Audio returned invalid Ogg Opus audio",
        false,
      );
    }
    return audio;
  }
}

export function prepareSpeechText(
  input: string,
  maxCharacters: number,
): { text: string; needsTextFollowUp: boolean } {
  let needsTextFollowUp = false;
  let text = input;

  text = text.replace(/```[\s\S]*?```/g, () => {
    needsTextFollowUp = true;
    return " I included the code in the text follow-up. ";
  });
  text = text.replace(/\[([^\]]+)\]\(https?:\/\/[^)]+\)/g, "$1");
  text = text.replace(/https?:\/\/\S+/g, () => {
    needsTextFollowUp = true;
    return " ";
  });
  text = text
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[(\d+)\]/g, "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-+*]\s+/gm, "")
    .replace(/[*_~>|]/g, " ")
    .replace(/\[source\s*\d+\]/gi, "")
    .replace(/\[ref\s*\d+\]/gi, "")
    .replace(/\(source[^)]*\)/gi, "")
    .replace(/\(see [^)]+\)/gi, "")
    .replace(/\bsource:\s*\S+/gi, "")
    .replace(/\bref:\s*\S+/gi, "")
    .replace(/\s+/g, " ")
    .trim();

  if (text.length > maxCharacters) {
    needsTextFollowUp = true;
    const suffix = " I put the rest in text.";
    const limit = Math.max(1, maxCharacters - suffix.length);
    const sentence = text.slice(0, limit).search(/[.!?](?=[^.!?]*$)/);
    const word = text.lastIndexOf(" ", limit);
    const cutAt = sentence >= Math.floor(limit * 0.6) ? sentence + 1 : word;
    text = `${text.slice(0, cutAt > 0 ? cutAt : limit).trim()}${suffix}`;
  }

  return { text, needsTextFollowUp };
}

export function readOggOpusDurationSeconds(audio: Uint8Array): number {
  const buffer = Buffer.from(audio);
  const opusHead = buffer.indexOf("OpusHead", 0, "ascii");
  if (opusHead < 0 || opusHead + 12 > buffer.length) {
    throw new VoiceSynthesisError(
      "Fish Audio response was not Ogg Opus",
      false,
    );
  }
  const preSkip = buffer.readUInt16LE(opusHead + 10);
  let offset = 0;
  let finalGranule = 0n;

  while (offset + 27 <= buffer.length) {
    if (buffer.subarray(offset, offset + 4).toString("ascii") !== "OggS") {
      throw new VoiceSynthesisError(
        "Fish Audio returned a malformed Ogg stream",
        false,
      );
    }
    const segmentCount = buffer[offset + 26] ?? 0;
    const segmentTableEnd = offset + 27 + segmentCount;
    if (segmentTableEnd > buffer.length) {
      throw new VoiceSynthesisError(
        "Fish Audio returned a truncated Ogg stream",
        false,
      );
    }
    let bodyLength = 0;
    for (let index = offset + 27; index < segmentTableEnd; index += 1) {
      bodyLength += buffer[index] ?? 0;
    }
    const pageEnd = segmentTableEnd + bodyLength;
    if (pageEnd > buffer.length) {
      throw new VoiceSynthesisError(
        "Fish Audio returned a truncated Ogg page",
        false,
      );
    }

    const granule = buffer.readBigUInt64LE(offset + 6);
    if (granule !== 0xffffffffffffffffn && granule > finalGranule)
      finalGranule = granule;
    offset = pageEnd;
  }

  const playableSamples = finalGranule - BigInt(preSkip);
  const duration = Number(playableSamples) / opusSampleRate;
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new VoiceSynthesisError(
      "Fish Audio returned audio without a valid duration",
      false,
    );
  }
  return Math.round(duration * 1_000) / 1_000;
}

export function createDiscordWaveform(
  audio: Uint8Array,
  durationSeconds: number,
): string {
  const sampleCount = Math.max(
    1,
    Math.min(256, Math.ceil(durationSeconds * 10)),
  );
  const waveform = Buffer.alloc(sampleCount);
  const start = Math.min(128, audio.length);
  const usableLength = Math.max(1, audio.length - start);

  for (let sample = 0; sample < sampleCount; sample += 1) {
    const from = start + Math.floor((sample * usableLength) / sampleCount);
    const to = start + Math.floor(((sample + 1) * usableLength) / sampleCount);
    let deviation = 0;
    let count = 0;
    for (
      let index = from;
      index < Math.max(from + 1, to) && index < audio.length;
      index += 1
    ) {
      deviation += Math.abs((audio[index] ?? 128) - 128);
      count += 1;
    }
    const normalized = count > 0 ? Math.round((deviation / count) * 1.8) : 1;
    waveform[sample] = Math.max(1, Math.min(255, normalized));
  }
  return waveform.toString("base64");
}

async function readBoundedResponse(
  response: Response,
  maxBytes: number,
): Promise<Buffer> {
  const declaredLength = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body?.cancel();
    throw new VoiceSynthesisError(
      "Fish Audio response exceeded the Discord upload limit",
      false,
    );
  }
  if (!response.body) {
    throw new VoiceSynthesisError(
      "Fish Audio returned an empty response",
      false,
    );
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new VoiceSynthesisError(
        "Fish Audio response exceeded the Discord upload limit",
        false,
      );
    }
    chunks.push(value);
  }
  return Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk)),
    total,
  );
}
