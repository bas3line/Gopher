import { describe, expect, test } from "bun:test";
import pino from "pino";
import { z } from "zod";
import {
  AgentLoop,
  AgentLoopError,
  AgentToolError,
} from "../src/agent/loop.ts";
import type { AgentTool } from "../src/agent/types.ts";
import type {
  AgentChatMessage,
  AgentCompletionClient,
  AgentTurnResult,
  ChatMessage,
  CompletionResult,
  FunctionToolDefinition,
} from "../src/ai/client.ts";

interface TestContext {
  events: string[];
}

class ScriptedAgentClient implements AgentCompletionClient {
  readonly seenMessages: AgentChatMessage[][] = [];
  readonly seenTools: FunctionToolDefinition[][] = [];

  constructor(private readonly turns: AgentTurnResult[]) {}

  async complete(
    _messages: ChatMessage[],
    _model: string,
  ): Promise<CompletionResult> {
    throw new Error("single-shot completion was not expected");
  }

  async completeToolTurn(
    messages: AgentChatMessage[],
    _model: string,
    tools: FunctionToolDefinition[],
  ): Promise<AgentTurnResult> {
    this.seenMessages.push(structuredClone(messages));
    this.seenTools.push(structuredClone(tools));
    const turn = this.turns.shift();
    if (!turn) throw new Error("scripted model ran out of turns");
    return turn;
  }
}

function toolTurn(
  calls: Array<{ id: string; name: string; arguments: string }>,
): AgentTurnResult {
  const toolCalls = calls.map((call) => ({
    id: call.id,
    type: "function" as const,
    function: { name: call.name, arguments: call.arguments },
  }));
  return {
    toolCalls,
    assistantMessage: {
      role: "assistant",
      content: null,
      tool_calls: toolCalls,
    },
  };
}

function finalTurn(content: string): AgentTurnResult {
  return {
    content,
    toolCalls: [],
    assistantMessage: {
      role: "assistant",
      content,
      tool_calls: [],
    },
  };
}

describe("bounded agent loop", () => {
  test("runs independent read tools in parallel and returns their results to the model", async () => {
    let active = 0;
    let maximumActive = 0;
    const readTool: AgentTool<TestContext, { query: string }> = {
      name: "lookup",
      description: "Look up a value",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
        additionalProperties: false,
      },
      schema: z.object({ query: z.string() }),
      effect: "read",
      parallelSafe: true,
      async execute(arguments_, context) {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await Bun.sleep(15);
        context.events.push(arguments_.query);
        active -= 1;
        return { value: arguments_.query.toUpperCase() };
      },
    };
    const client = new ScriptedAgentClient([
      toolTurn([
        { id: "one", name: "lookup", arguments: '{"query":"alpha"}' },
        { id: "two", name: "lookup", arguments: '{"query":"beta"}' },
      ]),
      {
        ...finalTurn("combined"),
        promptTokens: 20,
        completionTokens: 5,
      },
    ]);
    const loop = new AgentLoop({
      client,
      model: "test-model",
      tools: [readTool],
      logger: pino({ level: "silent" }),
    });
    const result = await loop.run({
      messages: [{ role: "user", content: "compare alpha and beta" }],
      context: { events: [] },
    });

    expect(maximumActive).toBe(2);
    expect(result.content).toBe("combined");
    expect(result.iterations).toBe(2);
    expect(result.toolCalls).toBe(2);
    expect(result.usage).toEqual({ promptTokens: 20, completionTokens: 5 });
    expect(
      client.seenMessages[1]
        ?.filter((message) => message.role === "tool")
        .map((message) => JSON.parse(String(message.content))),
    ).toEqual([
      { ok: true, result: { value: "ALPHA" } },
      { ok: true, result: { value: "BETA" } },
    ]);
  });

  test("serializes writes and deduplicates an identical write within a run", async () => {
    let writes = 0;
    const writeTool: AgentTool<TestContext, { content: string }> = {
      name: "send_message",
      description: "Send one message",
      parameters: {
        type: "object",
        properties: { content: { type: "string" } },
        required: ["content"],
        additionalProperties: false,
      },
      schema: z.object({ content: z.string() }),
      effect: "write",
      parallelSafe: false,
      async execute(arguments_, context) {
        writes += 1;
        context.events.push(arguments_.content);
        return { messageId: "123" };
      },
    };
    const client = new ScriptedAgentClient([
      toolTurn([
        {
          id: "send-one",
          name: "send_message",
          arguments: '{"content":"hello"}',
        },
        {
          id: "send-two",
          name: "send_message",
          arguments: '{"content":"hello"}',
        },
      ]),
      finalTurn("sent once"),
    ]);
    const loop = new AgentLoop({
      client,
      model: "test-model",
      tools: [writeTool],
      logger: pino({ level: "silent" }),
    });
    const result = await loop.run({
      messages: [{ role: "user", content: "send hello" }],
      context: { events: [] },
    });

    expect(writes).toBe(1);
    expect(result.executions.map((execution) => execution.cached)).toEqual([
      false,
      true,
    ]);
    expect(result.executions.map((execution) => execution.callId)).toEqual([
      "send-one",
      "send-two",
    ]);
  });

  test("returns validation and safe tool errors to the model instead of crashing", async () => {
    const guardedTool: AgentTool<TestContext, { value: number }> = {
      name: "guarded",
      description: "A guarded test tool",
      parameters: {
        type: "object",
        properties: { value: { type: "number" } },
        required: ["value"],
        additionalProperties: false,
      },
      schema: z.object({ value: z.number().int().positive() }),
      effect: "read",
      parallelSafe: true,
      async execute() {
        throw new AgentToolError("not_allowed", "That operation is not allowed");
      },
    };
    const client = new ScriptedAgentClient([
      toolTurn([
        { id: "bad-json", name: "guarded", arguments: "{" },
        {
          id: "bad-shape",
          name: "guarded",
          arguments: '{"value":-1}',
        },
        { id: "unknown", name: "missing", arguments: "{}" },
      ]),
      toolTurn([
        { id: "denied", name: "guarded", arguments: '{"value":1}' },
      ]),
      finalTurn("handled"),
    ]);
    const loop = new AgentLoop({
      client,
      model: "test-model",
      tools: [guardedTool],
      logger: pino({ level: "silent" }),
    });
    const result = await loop.run({
      messages: [{ role: "user", content: "exercise errors" }],
      context: { events: [] },
    });

    expect(result.executions.map((execution) => execution.errorCode)).toEqual([
      "invalid_json",
      "invalid_arguments",
      "unknown_tool",
      "not_allowed",
    ]);
    expect(result.content).toBe("handled");
  });

  test("fails closed when the model never stops calling tools", async () => {
    const client = new ScriptedAgentClient([
      toolTurn([{ id: "one", name: "lookup", arguments: '{"query":"x"}' }]),
      toolTurn([{ id: "two", name: "lookup", arguments: '{"query":"y"}' }]),
    ]);
    const tool: AgentTool<TestContext, { query: string }> = {
      name: "lookup",
      description: "Look up a value",
      parameters: { type: "object" },
      schema: z.object({ query: z.string() }),
      effect: "read",
      parallelSafe: true,
      async execute() {
        return {};
      },
    };
    const loop = new AgentLoop({
      client,
      model: "test-model",
      tools: [tool],
      logger: pino({ level: "silent" }),
      options: { maxIterations: 2 },
    });

    try {
      await loop.run({
        messages: [{ role: "user", content: "loop forever" }],
        context: { events: [] },
      });
      throw new Error("expected the loop to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(AgentLoopError);
      expect((error as AgentLoopError).code).toBe("iteration_limit");
    }
  });
});
