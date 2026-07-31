import { z } from "zod";
import type { Logger } from "../logger.ts";

const embeddingResponseSchema = z.object({
  data: z.array(
    z.object({
      embedding: z.array(z.number()),
      index: z.number().int().nonnegative(),
      object: z.literal("embedding").optional(),
    }),
  ),
  model: z.string().optional(),
  usage: z
    .object({
      prompt_tokens: z.number().int().nonnegative().optional(),
      total_tokens: z.number().int().nonnegative().optional(),
    })
    .optional(),
});

export interface EmbeddingResult {
  vectors: number[][];
  promptTokens?: number;
}

export interface EmbeddingProvider {
  readonly model: string;
  readonly dimensions: number;
  embed(inputs: string[], signal?: AbortSignal): Promise<EmbeddingResult>;
}

export class EmbeddingProviderError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = "EmbeddingProviderError";
  }
}

export class OpenAIEmbeddingClient implements EmbeddingProvider {
  readonly model: string;
  readonly dimensions: number;

  constructor(
    private readonly options: {
      endpoint: string;
      apiKey: string;
      model: string;
      dimensions: number;
      logger: Logger;
      timeoutMs?: number;
      maxRetries?: number;
      maximumBatchSize?: number;
      maximumInputCharacters?: number;
    },
  ) {
    this.model = options.model;
    this.dimensions = options.dimensions;
  }

  async embed(
    inputs: string[],
    signal?: AbortSignal,
  ): Promise<EmbeddingResult> {
    const maximumBatchSize = this.options.maximumBatchSize ?? 128;
    const maximumInputCharacters =
      this.options.maximumInputCharacters ?? 16_000;
    if (inputs.length === 0 || inputs.length > maximumBatchSize) {
      throw new EmbeddingProviderError(
        `Embedding batch must contain 1-${maximumBatchSize} inputs`,
        false,
      );
    }
    const normalized = inputs.map((input) => {
      const value = input.trim().slice(0, maximumInputCharacters);
      if (!value) {
        throw new EmbeddingProviderError(
          "Embedding input cannot be empty",
          false,
        );
      }
      return value;
    });

    const maxRetries = this.options.maxRetries ?? 2;
    let lastError: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      if (signal?.aborted) {
        throw new EmbeddingProviderError("Embedding request was aborted", false);
      }
      try {
        return await this.request(normalized, signal);
      } catch (error) {
        lastError = error;
        const retryable =
          error instanceof EmbeddingProviderError && error.retryable;
        if (!retryable || attempt === maxRetries) throw error;
        await abortableDelay(
          300 * 2 ** attempt + Math.floor(Math.random() * 100),
          signal,
        );
      }
    }
    throw lastError;
  }

  private async request(
    inputs: string[],
    signal?: AbortSignal,
  ): Promise<EmbeddingResult> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort("embedding_timeout"),
      this.options.timeoutMs ?? 45_000,
    );
    const abort = () => controller.abort(signal?.reason ?? "aborted");
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });

    let response: Response;
    try {
      response = await fetch(this.options.endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.options.apiKey}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({
          model: this.options.model,
          input: inputs,
          dimensions: this.options.dimensions,
          encoding_format: "float",
        }),
        signal: controller.signal,
        redirect: "error",
      });
    } catch (error) {
      if (signal?.aborted) {
        throw new EmbeddingProviderError("Embedding request was aborted", false);
      }
      const retryable =
        controller.signal.reason === "embedding_timeout" ||
        error instanceof TypeError ||
        (error instanceof DOMException &&
          (error.name === "AbortError" || error.name === "TimeoutError"));
      throw new EmbeddingProviderError(
        retryable
          ? "Embedding provider timed out or could not be reached"
          : "Embedding provider request failed",
        retryable,
      );
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
    }

    const requestId =
      response.headers.get("x-request-id") ??
      response.headers.get("cf-ray") ??
      undefined;
    if (!response.ok) {
      const retryable =
        response.status === 408 ||
        response.status === 429 ||
        response.status >= 500;
      this.options.logger.warn(
        { status: response.status, requestId, retryable },
        "embedding provider returned an error",
      );
      await response.body?.cancel();
      throw new EmbeddingProviderError(
        `Embedding provider returned HTTP ${response.status}${requestId ? ` (request ${requestId})` : ""}`,
        retryable,
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new EmbeddingProviderError(
        "Embedding provider returned invalid JSON",
        false,
      );
    }
    const parsed = embeddingResponseSchema.safeParse(payload);
    if (!parsed.success) {
      this.options.logger.warn(
        { issues: parsed.error.issues, requestId },
        "embedding provider response did not match the expected shape",
      );
      throw new EmbeddingProviderError(
        "Embedding provider returned an unexpected response",
        false,
      );
    }

    const vectors = new Array<number[] | undefined>(inputs.length);
    for (const item of parsed.data.data) {
      if (
        item.index >= inputs.length ||
        vectors[item.index] ||
        item.embedding.length !== this.options.dimensions ||
        item.embedding.some((value) => !Number.isFinite(value))
      ) {
        throw new EmbeddingProviderError(
          "Embedding provider returned invalid vector dimensions or indexes",
          false,
        );
      }
      vectors[item.index] = item.embedding;
    }
    if (vectors.some((vector) => vector === undefined)) {
      throw new EmbeddingProviderError(
        "Embedding provider omitted one or more vectors",
        false,
      );
    }
    return {
      vectors: vectors as number[][],
      ...(parsed.data.usage?.prompt_tokens !== undefined
        ? { promptTokens: parsed.data.usage.prompt_tokens }
        : {}),
    };
  }
}

function abortableDelay(
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(
      new EmbeddingProviderError("Embedding request was aborted", false),
    );
  }
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(done, milliseconds);
    signal?.addEventListener("abort", aborted, { once: true });
    function done() {
      signal?.removeEventListener("abort", aborted);
      resolve();
    }
    function aborted() {
      clearTimeout(timeout);
      reject(
        new EmbeddingProviderError("Embedding request was aborted", false),
      );
    }
  });
}
