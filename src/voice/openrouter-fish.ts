import type { Logger } from "../logger.ts";
import {
  createDiscordWaveform,
  prepareSpeechText,
  readOggOpusDurationSeconds,
  type SynthesizedVoiceMessage,
  type VoiceSynthesizer,
  VoiceSynthesisError,
} from "./fish-audio.ts";

const defaultApiBase = "https://openrouter.ai/api/v1";
const defaultMaxAudioBytes = 8 * 1024 * 1024;

/** OpenRouter returns raw 16-bit signed PCM at 44100 Hz mono regardless
 *  of the requested format. */
const openRouterPcmSampleRate = 44_100;
const openRouterPcmChannels = 1;
const openRouterPcmBytesPerSample = 2;

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

/**
 * OpenRouter-proxied Fish Audio voice synthesis using the free
 * fish-audio/s2.1-pro-free:free model.
 *
 * OpenRouter always returns raw 16-bit signed PCM at 44100 Hz mono.
 * We wrap it in a WAV container so Discord can play it directly.
 */
export class OpenRouterFishVoice implements VoiceSynthesizer {
  constructor(
    private readonly options: {
      apiKey?: string;
      referenceId: string;
      model: string;
      maxCharacters: number;
      logger: Logger;
      fetchImpl?: FetchLike;
      apiBaseUrl?: string;
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
      throw new VoiceSynthesisError(
        "OpenRouter Fish Audio is not configured",
        false,
      );
    }

    const prepared = prepareSpeechText(input, this.options.maxCharacters);
    if (!prepared.text) {
      throw new VoiceSynthesisError("The answer had no speakable text", false);
    }

    const maxRetries = this.options.maxRetries ?? 2;
    let lastError: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      try {
        const pcm = await this.requestPcm(prepared.text);
        const audio = pcmToWav44100Mono(pcm);
        const durationSeconds =
          pcm.length /
          (openRouterPcmSampleRate *
            openRouterPcmChannels *
            openRouterPcmBytesPerSample);
        return {
          audio,
          durationSeconds: Math.round(durationSeconds * 1_000) / 1_000,
          waveform: createDiscordWaveform(pcm, durationSeconds),
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

  private async requestPcm(text: string): Promise<Buffer> {
    const baseUrl = (this.options.apiBaseUrl ?? defaultApiBase).replace(
      /\/+$/,
      "",
    );
    const endpoint = `${baseUrl}/audio/speech`;
    const fetchImpl = this.options.fetchImpl ?? fetch;
    let response: Response;
    try {
      response = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.options.apiKey}`,
          "content-type": "application/json",
          accept: "audio/pcm, audio/ogg, application/octet-stream, */*",
          "HTTP-Referer": "https://github.com/bas3line/Gopher",
          "X-Title": "Gopher Discord Bot",
        },
        body: JSON.stringify({
          model: this.options.model,
          input: text,
          reference_id: this.options.referenceId,
          format: "opus",
          sample_rate: 48_000,
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
          ? "OpenRouter Fish Audio timed out or could not be reached"
          : "OpenRouter Fish Audio request failed",
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
        "OpenRouter Fish Audio returned an error",
      );
      await response.body?.cancel();
      throw new VoiceSynthesisError(
        `OpenRouter Fish Audio returned HTTP ${response.status}${requestId ? ` (request ${requestId})` : ""}`,
        retryable,
      );
    }

    const raw = await readBoundedResponse(
      response,
      this.options.maxAudioBytes ?? defaultMaxAudioBytes,
    );

    // OpenRouter always returns raw PCM regardless of requested format.
    // If it happens to be Ogg Opus, use it directly via the parent validator.
    if (
      raw.length >= 4 &&
      raw.subarray(0, 4).toString("ascii") === "OggS"
    ) {
      return raw;
    }

    // Must be raw PCM — validate minimum size (at least a few samples).
    if (raw.length < 64 || raw.length % 2 !== 0) {
      throw new VoiceSynthesisError(
        "OpenRouter Fish Audio returned unrecognized audio data",
        false,
      );
    }

    return raw;
  }
}

/** Wraps 44100 Hz mono signed-16-bit PCM in a RIFF WAV container. */
function pcmToWav44100Mono(pcm: Buffer): Buffer {
  if (pcm.length === 0) {
    throw new VoiceSynthesisError("PCM audio must not be empty", false);
  }
  if (pcm.length % openRouterPcmBytesPerSample !== 0) {
    throw new VoiceSynthesisError(
      "PCM audio must contain complete samples",
      false,
    );
  }
  if (pcm.length > 0xffff_ffff - 44) {
    throw new VoiceSynthesisError(
      "PCM audio is too large for a WAV container",
      false,
    );
  }

  const byteRate =
    openRouterPcmSampleRate *
    openRouterPcmChannels *
    openRouterPcmBytesPerSample;
  const blockAlign =
    openRouterPcmChannels * openRouterPcmBytesPerSample;

  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16); // PCM
  header.writeUInt16LE(1, 20); // format = PCM
  header.writeUInt16LE(openRouterPcmChannels, 22);
  header.writeUInt32LE(openRouterPcmSampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(16, 34); // bits per sample
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);

  return Buffer.concat([header, pcm], header.length + pcm.length);
}

async function readBoundedResponse(
  response: Response,
  maxBytes: number,
): Promise<Buffer> {
  const declaredLength = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body?.cancel();
    throw new VoiceSynthesisError(
      "OpenRouter Fish Audio response exceeded the Discord upload limit",
      false,
    );
  }
  if (!response.body) {
    throw new VoiceSynthesisError(
      "OpenRouter Fish Audio returned an empty response",
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
        "OpenRouter Fish Audio response exceeded the Discord upload limit",
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
