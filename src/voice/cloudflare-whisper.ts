import { z } from "zod";
import type { Logger } from "../logger.ts";
import { isPcmWav } from "./audio.ts";

const defaultApiBase = "https://api.cloudflare.com/client/v4";
const defaultMaxAudioBytes = 6 * 1024 * 1024;

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

const responseSchema = z
  .object({
    success: z.boolean().optional(),
    result: z
      .object({
        text: z.string().optional(),
      })
      .passthrough()
      .optional(),
    text: z.string().optional(),
  })
  .passthrough();

export class SpeechToTextError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = "SpeechToTextError";
  }
}

/** Direct Workers AI client for ephemeral Discord voice-chat transcription. */
export class CloudflareWhisper {
  constructor(
    private readonly options: {
      accountId: string;
      apiToken: string;
      model: string;
      language: string;
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

  async transcribe(audio: Buffer): Promise<string> {
    if (!this.enabled) {
      throw new SpeechToTextError("Cloudflare speech-to-text is not configured", false);
    }
    if (!/^@cf\/[a-z0-9._-]+\/[a-z0-9._-]+$/i.test(this.options.model)) {
      throw new SpeechToTextError("Cloudflare speech-to-text model ID is invalid", false);
    }
    if (!isPcmWav(audio)) {
      throw new SpeechToTextError("voice-chat audio was not a supported PCM WAV file", false);
    }
    if (audio.length > (this.options.maxAudioBytes ?? defaultMaxAudioBytes)) {
      throw new SpeechToTextError("voice-chat audio exceeded the transcription limit", false);
    }

    const maxRetries = this.options.maxRetries ?? 1;
    let lastError: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      try {
        return await this.request(audio);
      } catch (error) {
        lastError = error;
        const retryable =
          error instanceof SpeechToTextError && error.retryable;
        if (!retryable || attempt === maxRetries) throw error;
        await Bun.sleep(350 * 2 ** attempt + Math.floor(Math.random() * 100));
      }
    }
    throw lastError;
  }

  private async request(audio: Buffer): Promise<string> {
    const baseUrl = (this.options.apiBaseUrl ?? defaultApiBase).replace(/\/+$/, "");
    const endpoint = `${baseUrl}/accounts/${this.options.accountId}/ai/run/${this.options.model}`;
    const fetchImpl = this.options.fetchImpl ?? fetch;
    let response: Response;
    try {
      response = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.options.apiToken}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({
          audio: audio.toString("base64"),
          task: "transcribe",
          language: this.options.language,
          vad_filter: true,
          condition_on_previous_text: false,
          no_speech_threshold: 0.75,
          compression_ratio_threshold: 2.4,
        }),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 45_000),
        redirect: "error",
      });
    } catch (error) {
      const retryable =
        error instanceof TypeError ||
        (error instanceof DOMException && error.name === "TimeoutError");
      throw new SpeechToTextError(
        retryable
          ? "Cloudflare speech-to-text timed out or could not be reached"
          : "Cloudflare speech-to-text request failed",
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
        },
        "Cloudflare speech-to-text returned an error",
      );
      await response.body?.cancel();
      throw new SpeechToTextError(
        `Cloudflare speech-to-text returned HTTP ${response.status}${requestId ? ` (request ${requestId})` : ""}`,
        retryable,
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new SpeechToTextError(
        "Cloudflare speech-to-text returned invalid JSON",
        false,
      );
    }
    const parsed = responseSchema.safeParse(payload);
    if (!parsed.success || parsed.data.success === false) {
      this.options.logger.warn(
        { requestId, model: this.options.model },
        "Cloudflare speech-to-text returned an unexpected response",
      );
      throw new SpeechToTextError(
        "Cloudflare speech-to-text returned an unexpected response",
        false,
      );
    }

    const text = (parsed.data.result?.text ?? parsed.data.text ?? "").trim();
    if (!text) {
      throw new SpeechToTextError(
        "Cloudflare speech-to-text returned an empty transcription",
        false,
      );
    }
    return text;
  }
}
