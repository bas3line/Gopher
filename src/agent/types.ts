import type { z } from "zod";
import type {
  AgentChatMessage,
  FunctionToolDefinition,
} from "../ai/client.ts";

export type AgentToolEffect = "read" | "write";

export interface AgentToolExecutionContext {
  runId: string;
  callId: string;
  iteration: number;
  signal: AbortSignal;
}
export interface AgentTool<TContext = unknown, TArguments = unknown> {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  schema: z.ZodType<TArguments>;
  effect: AgentToolEffect;
  parallelSafe: boolean;
  timeoutMs?: number;
  execute(
    arguments_: TArguments,
    context: TContext,
    execution: AgentToolExecutionContext,
  ): Promise<unknown>;
}

export interface AgentToolExecution {
  callId: string;
  name: string;
  iteration: number;
  effect: AgentToolEffect | "unknown";
  success: boolean;
  cached: boolean;
  durationMs: number;
  output: string;
  errorCode?: string;
}

export interface AgentRunUsage {
  promptTokens: number;
  completionTokens: number;
}

export interface AgentRunResult {
  runId: string;
  content: string;
  iterations: number;
  toolCalls: number;
  messages: AgentChatMessage[];
  executions: AgentToolExecution[];
  usage: AgentRunUsage;
}

export interface AgentRunObserver {
  modelTurn?(event: {
    runId: string;
    iteration: number;
    toolCallCount: number;
    promptTokens?: number;
    completionTokens?: number;
  }): Promise<void> | void;
  toolExecution?(event: AgentToolExecution): Promise<void> | void;
}

export interface AgentLoopOptions {
  maxIterations: number;
  maxToolCalls: number;
  maxParallelToolCalls: number;
  maxRepeatedToolCall: number;
  runTimeoutMs: number;
  toolTimeoutMs: number;
  maxToolOutputCharacters: number;
}

export function asFunctionToolDefinition(
  tool: AgentTool<unknown, unknown>,
): FunctionToolDefinition {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  };
}
