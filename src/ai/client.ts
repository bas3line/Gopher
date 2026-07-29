import { z } from "zod";
import type { Logger } from "../logger.ts";

export type ChatRole = "system" | "user" | "assistant";

export type ChatContent =
  | string
  | Array<
      | { type: "text"; text: string }
      | {
          type: "image_url";
          image_url: { url: string; detail: "low" | "high" };
        }
    >;

export interface ChatMessage {
  role: ChatRole;
  content: ChatContent;
}

export interface CompletionResult {
  content: string;
  promptTokens?: number;
  completionTokens?: number;
  truncated?: boolean;
}

export interface CompletionClient {
  complete(messages: ChatMessage[], model: string): Promise<CompletionResult>;
}

export type ReasoningEffort =
  "none" | "low" | "medium" | "high" | "max" | "xhigh";

export function sanitizeModelOutput(input: string): string {
  let output = input.trim();
  const closingThink = output.toLowerCase().lastIndexOf("</think>");
  if (closingThink >= 0) {
    output = output.slice(closingThink + "</think>".length);
  }
  output = output.replace(/<think>[\s\S]*$/i, "").replace(/<\/?think>/gi, "");
  return output.trim();
}

const responseSchema = z.object({
  choices: z
    .array(
      z.object({
        finish_reason: z.string().nullable().optional(),
        message: z.object({
          content: z.string().nullable().optional(),
          reasoning_content: z.string().nullable().optional(),
        }),
      }),
    )
    .min(1),
  usage: z
    .object({
      prompt_tokens: z.number().int().optional(),
      completion_tokens: z.number().int().optional(),
    })
    .optional(),
});

export class AIProviderError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = "AIProviderError";
  }
}

export class AIClient implements CompletionClient {
  constructor(
    private readonly options: {
      endpoint: string;
      apiKey: string;
      maxTokens: number;
      logger: Logger;
      reasoningEffort?: ReasoningEffort;
      temperature?: number;
      acceptTruncatedOutput?: boolean;
      timeoutMs?: number;
      maxRetries?: number;
    },
  ) {}

  async complete(
    messages: ChatMessage[],
    model: string,
  ): Promise<CompletionResult> {
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

  private async request(
    messages: ChatMessage[],
    model: string,
  ): Promise<CompletionResult> {
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
          model,
          messages,
          max_tokens: this.options.maxTokens,
          temperature: this.options.temperature ?? 0.78,
          stream: false,
          ...(this.options.reasoningEffort
            ? { reasoning_effort: this.options.reasoningEffort }
            : {}),
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
          ? "AI provider timed out or could not be reached"
          : "AI provider request failed",
        retryable,
      );
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
        "AI provider returned an error",
      );
      await response.body?.cancel();
      throw new AIProviderError(
        `AI provider returned HTTP ${response.status}${requestId ? ` (request ${requestId})` : ""}`,
        retryable,
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new AIProviderError("AI provider returned invalid JSON", false);
    }

    const parsed = responseSchema.safeParse(payload);
    if (!parsed.success) {
      this.options.logger.warn(
        { issues: parsed.error.issues, requestId },
        "AI provider response did not match the expected shape",
      );
      throw new AIProviderError(
        "AI provider returned an unexpected response",
        false,
      );
    }

    const message = parsed.data.choices[0]?.message;
    const wasTruncated = parsed.data.choices[0]?.finish_reason === "length";
    if (wasTruncated && !this.options.acceptTruncatedOutput) {
      throw new AIProviderError(
        "AI provider exhausted its answer budget before completing the response",
        false,
      );
    }
    const content = sanitizeModelOutput(message?.content ?? "");
    if (!content) {
      const hadReasoning = Boolean(message?.reasoning_content?.trim());
      throw new AIProviderError(
        hadReasoning
          ? "AI provider exhausted its answer budget before producing a final response"
          : "AI provider returned an empty response",
        false,
      );
    }

    return {
      content,
      ...(parsed.data.usage?.prompt_tokens !== undefined
        ? { promptTokens: parsed.data.usage.prompt_tokens }
        : {}),
      ...(parsed.data.usage?.completion_tokens !== undefined
        ? { completionTokens: parsed.data.usage.completion_tokens }
        : {}),
      ...(wasTruncated ? { truncated: true } : {}),
    };
  }
}
