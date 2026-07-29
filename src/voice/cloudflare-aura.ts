import type { Logger } from "../logger.ts";
import {
  createDiscordWaveform,
  prepareSpeechText,
  readOggOpusDurationSeconds,
  type SynthesizedVoiceMessage,
  type VoiceSynthesizer,
  VoiceSynthesisError,
} from "./fish-audio.ts";

const defaultApiBase = "https://api.cloudflare.com/client/v4";
const defaultMaxAudioBytes = 8 * 1024 * 1024;

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export class CloudflareAuraVoice implements VoiceSynthesizer {
  constructor(
    private readonly options: {
      accountId: string;
      apiToken: string;
      model: string;
      speaker: string;
      maxCharacters: number;
      enabled: boolean;
      logger: Logger;
      fetchImpl?: FetchLike;
      apiBaseUrl?: string;
      timeoutMs?: number;
      maxRetries?: number;
      maxAudioBytes?: number;
    },
  ) {}

  get enabled(): boolean {
    return (
      this.options.enabled &&
      Boolean(this.options.accountId && this.options.apiToken)
    );
  }

  async synthesize(input: string): Promise<SynthesizedVoiceMessage> {
    if (!this.enabled) {
      throw new VoiceSynthesisError(
        "Cloudflare voice fallback is not configured",
        false,
      );
    }
    if (!/^@cf\/[a-z0-9._-]+\/[a-z0-9._-]+$/i.test(this.options.model)) {
      throw new VoiceSynthesisError(
        "Cloudflare voice model ID is invalid",
        false,
      );
    }

    const prepared = prepareSpeechText(input, this.options.maxCharacters);
    if (!prepared.text) {
      throw new VoiceSynthesisError("The answer had no speakable text", false);
    }

    const maxRetries = this.options.maxRetries ?? 1;
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
        await Bun.sleep(350 * 2 ** attempt + Math.floor(Math.random() * 100));
      }
    }
    throw lastError;
  }

  private async request(text: string): Promise<Buffer> {
    const baseUrl = (this.options.apiBaseUrl ?? defaultApiBase).replace(
      /\/+$/,
      "",
    );
    const endpoint = `${baseUrl}/accounts/${this.options.accountId}/ai/run/${this.options.model}`;
    const fetchImpl = this.options.fetchImpl ?? fetch;
    let response: Response;
    try {
      response = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.options.apiToken}`,
          "content-type": "application/json",
          accept: "audio/ogg, application/octet-stream",
        },
        body: JSON.stringify({
          text,
          speaker: this.options.speaker,
          encoding: "opus",
          container: "ogg",
        }),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 45_000),
        redirect: "error",
      });
    } catch (error) {
      const retryable =
        error instanceof TypeError ||
        (error instanceof DOMException && error.name === "TimeoutError");
      throw new VoiceSynthesisError(
        retryable
          ? "Cloudflare Aura timed out or could not be reached"
          : "Cloudflare Aura request failed",
        retryable,
      );
    }

    const requestId =
      response.headers.get("cf-ray") ??
      response.headers.get("x-request-id") ??
      undefined;
    if (!response.ok) {
      const retryable =
        response.status === 408 ||
        response.status === 429 ||
        response.status >= 500;
      this.options.logger.warn(
        {
          status: response.status,
          requestId,
          retryable,
          model: this.options.model,
          speaker: this.options.speaker,
        },
        "Cloudflare Aura returned an error",
      );
      await response.body?.cancel();
      throw new VoiceSynthesisError(
        `Cloudflare Aura returned HTTP ${response.status}${requestId ? ` (request ${requestId})` : ""}`,
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
        "Cloudflare Aura returned invalid Ogg Opus audio",
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
      "Cloudflare Aura response exceeded the Discord upload limit",
      false,
    );
  }
  if (!response.body) {
    throw new VoiceSynthesisError(
      "Cloudflare Aura returned an empty response",
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
        "Cloudflare Aura response exceeded the Discord upload limit",
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
