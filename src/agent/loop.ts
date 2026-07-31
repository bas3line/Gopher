import { randomUUID } from "node:crypto";
import type { AgentCompletionClient, AssistantToolCall } from "../ai/client.ts";
import type { Logger } from "../logger.ts";
import {
  asFunctionToolDefinition,
  type AgentLoopOptions,
  type AgentRunObserver,
  type AgentRunResult,
  type AgentTool,
  type AgentToolExecution,
} from "./types.ts";

const defaultOptions: AgentLoopOptions = {
  maxIterations: 8,
  maxToolCalls: 24,
  maxParallelToolCalls: 6,
  maxRepeatedToolCall: 2,
  runTimeoutMs: 120_000,
  toolTimeoutMs: 30_000,
  maxToolOutputCharacters: 14_000,
};

export class AgentLoopError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "iteration_limit"
      | "tool_budget"
      | "run_timeout"
      | "aborted"
      | "invalid_tool_registry",
  ) {
    super(message);
    this.name = "AgentLoopError";
  }
}

export class AgentToolError extends Error {
  constructor(
    public readonly code: string,
    public readonly safeMessage: string,
  ) {
    super(safeMessage);
    this.name = "AgentToolError";
  }
}

export class AgentLoop<TContext> {
  private readonly options: AgentLoopOptions;

  constructor(
    private readonly dependencies: {
      client: AgentCompletionClient;
      model: string;
      tools: AgentTool<TContext, any>[];
      logger: Logger;
      observer?: AgentRunObserver;
      options?: Partial<AgentLoopOptions>;
    },
  ) {
    this.options = { ...defaultOptions, ...dependencies.options };
    validateOptions(this.options);
    const names = dependencies.tools.map((tool) => tool.name);
    if (new Set(names).size !== names.length) {
      throw new AgentLoopError(
        "Agent tool names must be unique",
        "invalid_tool_registry",
      );
    }
  }

  async run(input: {
    messages: AgentRunResult["messages"];
    context: TContext;
    runId?: string;
    signal?: AbortSignal;
  }): Promise<AgentRunResult> {
    const runId = input.runId ?? randomUUID();
    const startedAt = Date.now();
    const messages = [...input.messages];
    const definitions = this.dependencies.tools.map((tool) =>
      asFunctionToolDefinition(tool as AgentTool<unknown, unknown>),
    );
    const tools = new Map(
      this.dependencies.tools.map((tool) => [tool.name, tool] as const),
    );
    const executions: AgentToolExecution[] = [];
    const repeatedCalls = new Map<string, number>();
    const writeResultCache = new Map<string, AgentToolExecution>();
    let toolCalls = 0;
    let promptTokens = 0;
    let completionTokens = 0;

    for (
      let iteration = 1;
      iteration <= this.options.maxIterations;
      iteration += 1
    ) {
      this.assertRunActive(input.signal, startedAt);
      const turn = await this.dependencies.client.completeToolTurn(
        messages,
        this.dependencies.model,
        definitions,
      );
      promptTokens += turn.promptTokens ?? 0;
      completionTokens += turn.completionTokens ?? 0;
      messages.push(turn.assistantMessage);
      await this.dependencies.observer?.modelTurn?.({
        runId,
        iteration,
        toolCallCount: turn.toolCalls.length,
        ...(turn.promptTokens !== undefined
          ? { promptTokens: turn.promptTokens }
          : {}),
        ...(turn.completionTokens !== undefined
          ? { completionTokens: turn.completionTokens }
          : {}),
      });

      if (turn.toolCalls.length === 0) {
        return {
          runId,
          content: turn.content ?? "",
          iterations: iteration,
          toolCalls,
          messages,
          executions,
          usage: { promptTokens, completionTokens },
        };
      }

      if (toolCalls + turn.toolCalls.length > this.options.maxToolCalls) {
        throw new AgentLoopError(
          `Agent exceeded the ${this.options.maxToolCalls}-call tool budget`,
          "tool_budget",
        );
      }
      toolCalls += turn.toolCalls.length;

      const turnExecutions = await this.executeTurnTools({
        runId,
        iteration,
        calls: turn.toolCalls,
        tools,
        context: input.context,
        ...(input.signal ? { signal: input.signal } : {}),
        startedAt,
        repeatedCalls,
        writeResultCache,
      });
      for (const execution of turnExecutions) {
        executions.push(execution);
        messages.push({
          role: "tool",
          tool_call_id: execution.callId,
          name: execution.name,
          content: execution.output,
        });
        await this.dependencies.observer?.toolExecution?.(execution);
      }
    }

    throw new AgentLoopError(
      `Agent did not finish within ${this.options.maxIterations} iterations`,
      "iteration_limit",
    );
  }

  private async executeTurnTools(input: {
    runId: string;
    iteration: number;
    calls: AssistantToolCall[];
    tools: Map<string, AgentTool<TContext, any>>;
    context: TContext;
    signal?: AbortSignal;
    startedAt: number;
    repeatedCalls: Map<string, number>;
    writeResultCache: Map<string, AgentToolExecution>;
  }): Promise<AgentToolExecution[]> {
    const results = new Array<AgentToolExecution | undefined>(
      input.calls.length,
    );
    const parallel: Array<{
      index: number;
      call: AssistantToolCall;
    }> = [];
    const sequential: Array<{
      index: number;
      call: AssistantToolCall;
    }> = [];

    for (const [index, call] of input.calls.entries()) {
      const tool = input.tools.get(call.function.name);
      if (tool?.effect === "read" && tool.parallelSafe) {
        parallel.push({ index, call });
      } else {
        sequential.push({ index, call });
      }
    }

    await mapWithConcurrency(
      parallel,
      this.options.maxParallelToolCalls,
      async ({ index, call }) => {
        results[index] = await this.executeTool({
          ...input,
          call,
        });
      },
    );
    for (const { index, call } of sequential) {
      results[index] = await this.executeTool({
        ...input,
        call,
      });
    }

    return results.filter(
      (result): result is AgentToolExecution => result !== undefined,
    );
  }

  private async executeTool(input: {
    runId: string;
    iteration: number;
    call: AssistantToolCall;
    tools: Map<string, AgentTool<TContext, any>>;
    context: TContext;
    signal?: AbortSignal;
    startedAt: number;
    repeatedCalls: Map<string, number>;
    writeResultCache: Map<string, AgentToolExecution>;
  }): Promise<AgentToolExecution> {
    const startedAt = performance.now();
    const tool = input.tools.get(input.call.function.name);
    if (!tool) {
      return this.failedExecution(
        input,
        startedAt,
        "unknown",
        "unknown_tool",
        `Unknown tool: ${input.call.function.name}`,
      );
    }

    let decoded: unknown;
    try {
      decoded = JSON.parse(input.call.function.arguments);
    } catch {
      return this.failedExecution(
        input,
        startedAt,
        tool.effect,
        "invalid_json",
        "Tool arguments were not valid JSON",
      );
    }
    const parsed = tool.schema.safeParse(decoded);
    if (!parsed.success) {
      return this.failedExecution(
        input,
        startedAt,
        tool.effect,
        "invalid_arguments",
        parsed.error.issues
          .slice(0, 6)
          .map((issue) => `${issue.path.join(".") || "arguments"}: ${issue.message}`)
          .join("; "),
      );
    }

    const fingerprint = `${tool.name}:${stableStringify(parsed.data)}`;
    const repeated = (input.repeatedCalls.get(fingerprint) ?? 0) + 1;
    input.repeatedCalls.set(fingerprint, repeated);
    if (repeated > this.options.maxRepeatedToolCall) {
      return this.failedExecution(
        input,
        startedAt,
        tool.effect,
        "repeated_call",
        "This exact tool call already ran enough times; use its prior result or change the arguments",
      );
    }

    if (tool.effect === "write") {
      const cached = input.writeResultCache.get(fingerprint);
      if (cached?.success) {
        return {
          ...cached,
          callId: input.call.id,
          iteration: input.iteration,
          cached: true,
          durationMs: Math.round(performance.now() - startedAt),
        };
      }
    }

    this.assertRunActive(input.signal, input.startedAt);
    const timeoutMs = tool.timeoutMs ?? this.options.toolTimeoutMs;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort("tool_timeout"), timeoutMs);
    const abort = () => controller.abort(input.signal?.reason ?? "aborted");
    input.signal?.addEventListener("abort", abort, { once: true });

    try {
      const result = await tool.execute(parsed.data, input.context, {
        runId: input.runId,
        callId: input.call.id,
        iteration: input.iteration,
        signal: controller.signal,
      });
      if (controller.signal.aborted) {
        throw new AgentToolError(
          controller.signal.reason === "tool_timeout"
            ? "tool_timeout"
            : "aborted",
          controller.signal.reason === "tool_timeout"
            ? `Tool exceeded its ${timeoutMs}ms timeout`
            : "Tool execution was aborted",
        );
      }
      const execution: AgentToolExecution = {
        callId: input.call.id,
        name: tool.name,
        iteration: input.iteration,
        effect: tool.effect,
        success: true,
        cached: false,
        durationMs: Math.round(performance.now() - startedAt),
        output: serializeToolOutput(
          { ok: true, result },
          this.options.maxToolOutputCharacters,
        ),
      };
      if (tool.effect === "write") {
        input.writeResultCache.set(fingerprint, execution);
      }
      return execution;
    } catch (error) {
      const known = error instanceof AgentToolError;
      this.dependencies.logger.warn(
        {
          err: known
            ? { name: error.name, code: error.code }
            : error instanceof Error
              ? { name: error.name, message: error.message }
              : "unknown tool error",
          tool: tool.name,
          runId: input.runId,
          callId: input.call.id,
        },
        "agent tool execution failed",
      );
      return this.failedExecution(
        input,
        startedAt,
        tool.effect,
        known ? error.code : "tool_failed",
        known ? error.safeMessage : "Tool execution failed",
      );
    } finally {
      clearTimeout(timeout);
      input.signal?.removeEventListener("abort", abort);
    }
  }

  private failedExecution(
    input: {
      call: AssistantToolCall;
      iteration: number;
    },
    startedAt: number,
    effect: AgentToolExecution["effect"],
    code: string,
    message: string,
  ): AgentToolExecution {
    return {
      callId: input.call.id,
      name: input.call.function.name,
      iteration: input.iteration,
      effect,
      success: false,
      cached: false,
      durationMs: Math.round(performance.now() - startedAt),
      errorCode: code,
      output: serializeToolOutput(
        { ok: false, error: { code, message } },
        this.options.maxToolOutputCharacters,
      ),
    };
  }

  private assertRunActive(
    signal: AbortSignal | undefined,
    startedAt: number,
  ): void {
    if (signal?.aborted) {
      throw new AgentLoopError("Agent run was aborted", "aborted");
    }
    if (Date.now() - startedAt >= this.options.runTimeoutMs) {
      throw new AgentLoopError(
        `Agent exceeded its ${this.options.runTimeoutMs}ms run timeout`,
        "run_timeout",
      );
    }
  }
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

export function serializeToolOutput(
  value: unknown,
  maximumCharacters: number,
): string {
  const serialized = JSON.stringify(value);
  if (serialized.length <= maximumCharacters) return serialized;
  return JSON.stringify({
    ok: true,
    truncated: true,
    output: serialized.slice(0, Math.max(0, maximumCharacters - 120)),
  });
}

async function mapWithConcurrency<T>(
  values: T[],
  concurrency: number,
  operation: (value: T) => Promise<void>,
): Promise<void> {
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (nextIndex < values.length) {
        const index = nextIndex;
        nextIndex += 1;
        const value = values[index];
        if (value !== undefined) await operation(value);
      }
    },
  );
  await Promise.all(workers);
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, sortJson(nested)]),
  );
}

function validateOptions(options: AgentLoopOptions): void {
  for (const [name, value] of Object.entries(options)) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new AgentLoopError(
        `Agent loop option ${name} must be a positive integer`,
        "invalid_tool_registry",
      );
    }
  }
}
