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
  complete(
    messages: ChatMessage[],
    model: string,
    signal?: AbortSignal,
  ): Promise<CompletionResult>;
}

export interface FunctionToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    strict?: boolean;
  };
}

export interface AssistantToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export type AgentChatMessage =
  | ChatMessage
  | {
      role: "assistant";
      content: string | null;
      tool_calls: AssistantToolCall[];
    }
  | {
      role: "tool";
      tool_call_id: string;
      name: string;
      content: string;
    };

export interface AgentTurnResult {
  content?: string;
  toolCalls: AssistantToolCall[];
  assistantMessage: Extract<AgentChatMessage, { role: "assistant" }>;
  promptTokens?: number;
  completionTokens?: number;
}

export interface AgentCompletionClient extends CompletionClient {
  completeToolTurn(
    messages: AgentChatMessage[],
    model: string,
    tools: FunctionToolDefinition[],
    signal?: AbortSignal,
  ): Promise<AgentTurnResult>;
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
          tool_calls: z
            .array(
              z.object({
                id: z.string().min(1),
                type: z.literal("function"),
                function: z.object({
                  name: z.string().min(1),
                  arguments: z.string(),
                }),
              }),
            )
            .optional(),
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
    public readonly status?: number,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "AIProviderError";
  }
}

interface ProviderTurn {
  content: string;
  reasoningContent: string;
  toolCalls: AssistantToolCall[];
  finishReason?: string | null;
  promptTokens?: number;
  completionTokens?: number;
}

export class AIClient implements AgentCompletionClient {
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
      retryBaseDelayMs?: number;
      maxRetryDelayMs?: number;
    },
  ) {}

  async complete(
    messages: ChatMessage[],
    model: string,
    signal?: AbortSignal,
  ): Promise<CompletionResult> {
    const turn = await this.completeProviderTurn(
      messages,
      model,
      undefined,
      signal,
    );
    const wasTruncated = turn.finishReason === "length";
    if (wasTruncated && !this.options.acceptTruncatedOutput) {
      throw new AIProviderError(
        "AI provider exhausted its answer budget before completing the response",
        false,
      );
    }
    if (!turn.content) {
      throw new AIProviderError(
        turn.reasoningContent
          ? "AI provider exhausted its answer budget before producing a final response"
          : "AI provider returned an empty response",
        false,
      );
    }

    return {
      content: turn.content,
      ...(turn.promptTokens !== undefined
        ? { promptTokens: turn.promptTokens }
        : {}),
      ...(turn.completionTokens !== undefined
        ? { completionTokens: turn.completionTokens }
        : {}),
      ...(wasTruncated ? { truncated: true } : {}),
    };
  }

  async completeToolTurn(
    messages: AgentChatMessage[],
    model: string,
    tools: FunctionToolDefinition[],
    signal?: AbortSignal,
  ): Promise<AgentTurnResult> {
    const turn = await this.completeProviderTurn(
      messages,
      model,
      tools,
      signal,
    );
    if (turn.finishReason === "length") {
      throw new AIProviderError(
        "AI provider exhausted its answer budget during an agent turn",
        false,
      );
    }
    if (!turn.content && turn.toolCalls.length === 0) {
      throw new AIProviderError(
        turn.reasoningContent
          ? "AI provider exhausted its answer budget before producing an agent action"
          : "AI provider returned an empty agent turn",
        false,
      );
    }

    const assistantMessage = {
      role: "assistant" as const,
      content: turn.content || null,
      tool_calls: turn.toolCalls,
    };
    return {
      ...(turn.content ? { content: turn.content } : {}),
      toolCalls: turn.toolCalls,
      assistantMessage,
      ...(turn.promptTokens !== undefined
        ? { promptTokens: turn.promptTokens }
        : {}),
      ...(turn.completionTokens !== undefined
        ? { completionTokens: turn.completionTokens }
        : {}),
    };
  }

  private async completeProviderTurn(
    messages: AgentChatMessage[],
    model: string,
    tools?: FunctionToolDefinition[],
    signal?: AbortSignal,
  ): Promise<ProviderTurn> {
    const maxRetries = this.options.maxRetries ?? 2;
    let lastError: unknown;

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      if (signal?.aborted) {
        throw new AIProviderError("AI provider request was aborted", false);
      }
      try {
        return await this.request(messages, model, tools, signal);
      } catch (error) {
        lastError = error;
        const retryable = error instanceof AIProviderError && error.retryable;
        if (!retryable || attempt === maxRetries) throw error;
        const fallbackDelay =
          (this.options.retryBaseDelayMs ?? 750) * 2 ** attempt +
          Math.floor(Math.random() * 200);
        const delay = Math.min(
          this.options.maxRetryDelayMs ?? 30_000,
          Math.max(100, fallbackDelay, error.retryAfterMs ?? 0),
        );
        await abortableSleep(delay, signal);
      }
    }

    throw lastError;
  }

  private async request(
    messages: AgentChatMessage[],
    model: string,
    tools?: FunctionToolDefinition[],
    signal?: AbortSignal,
  ): Promise<ProviderTurn> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort("provider_timeout"),
      this.options.timeoutMs ?? 75_000,
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
          model,
          messages,
          max_tokens: this.options.maxTokens,
          temperature: this.options.temperature ?? 0.78,
          stream: false,
          ...(this.options.reasoningEffort
            ? { reasoning_effort: this.options.reasoningEffort }
            : {}),
          ...(tools?.length
            ? {
                tools,
                tool_choice: "auto",
                parallel_tool_calls: true,
              }
            : {}),
        }),
        signal: controller.signal,
        redirect: "error",
      });
    } catch (error) {
      if (signal?.aborted) {
        throw new AIProviderError("AI provider request was aborted", false);
      }
      const retryable =
        controller.signal.reason === "provider_timeout" ||
        error instanceof TypeError ||
        (error instanceof DOMException &&
          (error.name === "AbortError" || error.name === "TimeoutError"));
      throw new AIProviderError(
        retryable
          ? "AI provider timed out or could not be reached"
          : "AI provider request failed",
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
      const retryAfterMs = retryAfterMilliseconds(
        response.headers.get("retry-after"),
      );
      this.options.logger.warn(
        { status: response.status, requestId, retryable, retryAfterMs },
        "AI provider returned an error",
      );
      await response.body?.cancel();
      throw new AIProviderError(
        `AI provider returned HTTP ${response.status}${requestId ? ` (request ${requestId})` : ""}`,
        retryable,
        response.status,
        retryAfterMs,
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
    const content = sanitizeModelOutput(message?.content ?? "");
    return {
      content,
      reasoningContent: message?.reasoning_content?.trim() ?? "",
      toolCalls: message?.tool_calls ?? [],
      ...(parsed.data.choices[0]?.finish_reason !== undefined
        ? { finishReason: parsed.data.choices[0]?.finish_reason }
        : {}),
      ...(parsed.data.usage?.prompt_tokens !== undefined
        ? { promptTokens: parsed.data.usage.prompt_tokens }
        : {}),
      ...(parsed.data.usage?.completion_tokens !== undefined
        ? { completionTokens: parsed.data.usage.completion_tokens }
        : {}),
    };
  }
}

export function retryAfterMilliseconds(
  value: string | null,
  now = Date.now(),
): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1_000);
  }
  const resetAt = Date.parse(value);
  if (!Number.isFinite(resetAt)) return undefined;
  return Math.max(0, resetAt - now);
}

function abortableSleep(
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> {
  if (!signal) return Bun.sleep(milliseconds);
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = setTimeout(done, milliseconds);
    signal.addEventListener("abort", done, { once: true });
    function done() {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", done);
      resolve();
    }
  });
}
