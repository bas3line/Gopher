import { z } from "zod";
import type { Logger } from "../logger.ts";
import {
  AIProviderError,
  sanitizeModelOutput,
  type ChatMessage,
  type CompletionClient,
  type CompletionResult,
} from "./client.ts";

const usageSchema = z
  .object({
    prompt_tokens: z.number().int().optional(),
    completion_tokens: z.number().int().optional(),
  })
  .passthrough();

const responseSchema = z.object({
  success: z.boolean(),
  errors: z
    .array(
      z.object({
        code: z.union([z.number(), z.string()]).optional(),
        message: z.string().optional(),
      }),
    )
    .default([]),
  result: z
    .object({
      response: z.string().nullable().optional(),
      choices: z
        .array(
          z.object({
            finish_reason: z.string().nullable().optional(),
            text: z.string().nullable().optional(),
            message: z
              .object({
                content: z.string().nullable().optional(),
                reasoning_content: z.string().nullable().optional(),
              })
              .optional(),
          }),
        )
        .optional(),
      usage: usageSchema.optional(),
    })
    .passthrough()
    .optional(),
});

export class CloudflareAIClient implements CompletionClient {
  constructor(
    private readonly options: {
      accountId: string;
      apiToken: string;
      maxTokens: number;
      logger: Logger;
      apiBaseUrl?: string;
      timeoutMs?: number;
      maxRetries?: number;
    },
  ) {}

  async complete(messages: ChatMessage[], model: string): Promise<CompletionResult> {
    const maxRetries = this.options.maxRetries ?? 2;
    let lastError: unknown;

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      try {
        return await this.request(messages, model);
      } catch (error) {
        lastError = error;
        const retryable = error instanceof AIProviderError && error.retryable;
        if (!retryable || attempt === maxRetries) throw error;
        await Bun.sleep(350 * 2 ** attempt + Math.floor(Math.random() * 150));
      }
    }

    throw lastError;
  }

  private async request(messages: ChatMessage[], model: string): Promise<CompletionResult> {
    if (!/^@cf\/[a-z0-9._-]+\/[a-z0-9._-]+$/i.test(model)) {
      throw new AIProviderError("Cloudflare model ID is invalid", false);
    }
    if (messages.some((message) => typeof message.content !== "string")) {
      throw new AIProviderError("Cloudflare text requests cannot contain images", false);
    }

    const baseUrl = (this.options.apiBaseUrl ?? "https://api.cloudflare.com/client/v4").replace(
      /\/+$/,
      "",
    );
    const endpoint = `${baseUrl}/accounts/${this.options.accountId}/ai/run/${model}`;
    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.options.apiToken}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({
          messages,
          max_tokens: this.options.maxTokens,
          stream: false,
        }),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 75_000),
        redirect: "error",
      });
    } catch (error) {
      const retryable =
        error instanceof TypeError ||
        (error instanceof DOMException && error.name === "TimeoutError");
      throw new AIProviderError(
        retryable
          ? "Cloudflare Workers AI timed out or could not be reached"
          : "Cloudflare Workers AI request failed",
        retryable,
      );
    }

    const requestId =
      response.headers.get("cf-ray") ?? response.headers.get("x-request-id") ?? undefined;
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new AIProviderError("Cloudflare Workers AI returned invalid JSON", false);
    }

    const parsed = responseSchema.safeParse(payload);
    if (!parsed.success) {
      this.options.logger.warn(
        { status: response.status, requestId, issues: parsed.error.issues },
        "Cloudflare Workers AI response did not match the expected shape",
      );
      throw new AIProviderError("Cloudflare Workers AI returned an unexpected response", false);
    }

    if (!response.ok || !parsed.data.success) {
      const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
      this.options.logger.warn(
        {
          status: response.status,
          requestId,
          retryable,
          errorCodes: parsed.data.errors.map((error) => error.code).filter(Boolean),
        },
        "Cloudflare Workers AI returned an error",
      );
      throw new AIProviderError(
        `Cloudflare Workers AI returned HTTP ${response.status}${requestId ? ` (request ${requestId})` : ""}`,
        retryable,
      );
    }

    const result = parsed.data.result;
    const choice = result?.choices?.[0];
    if (choice?.finish_reason === "length") {
      throw new AIProviderError(
        "Cloudflare Workers AI exhausted its answer budget before completing the response",
        false,
      );
    }
    const content = sanitizeModelOutput(
      choice?.message?.content ?? choice?.text ?? result?.response ?? "",
    );
    if (!content) {
      const hadReasoning = Boolean(choice?.message?.reasoning_content?.trim());
      throw new AIProviderError(
        hadReasoning
          ? "Cloudflare Workers AI exhausted its answer budget before producing a final response"
          : "Cloudflare Workers AI returned an empty response",
        false,
      );
    }

    return {
      content,
      ...(result?.usage?.prompt_tokens !== undefined
        ? { promptTokens: result.usage.prompt_tokens }
        : {}),
      ...(result?.usage?.completion_tokens !== undefined
        ? { completionTokens: result.usage.completion_tokens }
        : {}),
    };
  }
}
