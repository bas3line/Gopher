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

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

/**
 * OpenRouter-proxied Fish Audio voice synthesis using the free
 * fish-audio/s2.1-pro-free:free model.
 *
 * Request/response format mirrors Fish Audio's native TTS API, routed
 * through OpenRouter's OpenAI-compatible gateway.
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
          accept: "audio/ogg, application/octet-stream",
          "HTTP-Referer": "https://github.com/bas3line/Gopher",
          "X-Title": "Gopher Discord Bot",
        },
        body: JSON.stringify({
          model: this.options.model,
          input: text,
          voice: this.options.referenceId,
          response_format: "opus",
          // Fish Audio provider-specific parameters passed through
          reference_id: this.options.referenceId,
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

    const audio = await readBoundedAudio(
      response,
      this.options.maxAudioBytes ?? defaultMaxAudioBytes,
    );
    if (
      audio.length < 32 ||
      audio.subarray(0, 4).toString("ascii") !== "OggS"
    ) {
      throw new VoiceSynthesisError(
        "OpenRouter Fish Audio returned invalid Ogg Opus audio",
        false,
      );
    }
    return audio;
  }
}

async function readBoundedAudio(
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
