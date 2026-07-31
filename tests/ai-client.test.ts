import { afterEach, describe, expect, test } from "bun:test";
import pino from "pino";
import {
  AIClient,
  AIProviderError,
  retryAfterMilliseconds,
  sanitizeModelOutput,
} from "../src/ai/client.ts";

let server: Bun.Server<undefined> | undefined;
afterEach(() => {
  server?.stop(true);
  server = undefined;
});

function startServer(
  handler: (request: Request) => Response | Promise<Response>,
): string {
  server = Bun.serve({ port: 0, fetch: handler });
  return `http://127.0.0.1:${server.port}/v1/chat/completions`;
}

describe("OpenAI-compatible client", () => {
  test("removes leaked reasoning markers and their hidden prefix", () => {
    expect(
      sanitizeModelOutput("meowmeowmeowmewo</think>cat got your keyboard?"),
    ).toBe("cat got your keyboard?");
    expect(
      sanitizeModelOutput("<think>private chain</think>final answer"),
    ).toBe("final answer");
    expect(sanitizeModelOutput("normal answer")).toBe("normal answer");
  });

  test("sends the selected model and parses usage", async () => {
    const endpoint = startServer(async (request) => {
      expect(request.headers.get("authorization")).toBe(
        "Bearer local-test-key",
      );
      const body = (await request.json()) as Record<string, unknown>;
      expect(body.model).toBe("fun-model");
      expect(body.max_tokens).toBe(2_400);
      expect(body.reasoning_effort).toBe("none");
      return Response.json({
        choices: [{ message: { content: "  absolutely cooked  " } }],
        usage: { prompt_tokens: 12, completion_tokens: 3 },
      });
    });
    const client = new AIClient({
      endpoint,
      apiKey: "local-test-key",
      maxTokens: 2_400,
      reasoningEffort: "none",
      logger: pino({ level: "silent" }),
      maxRetries: 0,
    });
    await expect(
      client.complete([{ role: "user", content: "hello" }], "fun-model"),
    ).resolves.toEqual({
      content: "absolutely cooked",
      promptTokens: 12,
      completionTokens: 3,
    });
  });

  test("rejects reasoning-only responses instead of pretending success", async () => {
    const endpoint = startServer(() =>
      Response.json({
        choices: [
          { message: { content: "", reasoning_content: "thinking forever" } },
        ],
      }),
    );
    const client = new AIClient({
      endpoint,
      apiKey: "local-test-key",
      maxTokens: 2_400,
      logger: pino({ level: "silent" }),
      maxRetries: 0,
    });
    await expect(
      client.complete([{ role: "user", content: "hello" }], "fun-model"),
    ).rejects.toThrow("exhausted its answer budget");
  });

  test("can retain usable text from a configured truncated background response", async () => {
    const endpoint = startServer(async (request) => {
      const body = (await request.json()) as Record<string, unknown>;
      expect(body.temperature).toBe(0.2);
      return Response.json({
        choices: [
          {
            finish_reason: "length",
            message: { content: "compact summary that remains useful" },
          },
        ],
      });
    });
    const client = new AIClient({
      endpoint,
      apiKey: "local-test-key",
      maxTokens: 16_384,
      temperature: 0.2,
      acceptTruncatedOutput: true,
      logger: pino({ level: "silent" }),
      maxRetries: 0,
    });
    await expect(
      client.complete([{ role: "user", content: "summarize" }], "fun-model"),
    ).resolves.toEqual({
      content: "compact summary that remains useful",
      truncated: true,
    });
  });

  test("marks authentication failures as non-retryable", async () => {
    const endpoint = startServer(() => new Response(null, { status: 401 }));
    const client = new AIClient({
      endpoint,
      apiKey: "bad-test-key",
      maxTokens: 2_400,
      logger: pino({ level: "silent" }),
      maxRetries: 0,
    });
    try {
      await client.complete([{ role: "user", content: "hello" }], "fun-model");
      throw new Error("expected request to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(AIProviderError);
      expect((error as AIProviderError).retryable).toBeFalse();
      expect((error as AIProviderError).status).toBe(401);
    }
  });

  test("honors rate-limit metadata and retries a foreground request", async () => {
    let requests = 0;
    const endpoint = startServer(() => {
      requests += 1;
      if (requests === 1) {
        return new Response(null, {
          status: 429,
          headers: { "retry-after": "0" },
        });
      }
      return Response.json({
        choices: [{ message: { content: "recovered" } }],
      });
    });
    const client = new AIClient({
      endpoint,
      apiKey: "local-test-key",
      maxTokens: 2_400,
      logger: pino({ level: "silent" }),
      maxRetries: 1,
      retryBaseDelayMs: 1,
      maxRetryDelayMs: 5,
    });
    await expect(
      client.complete([{ role: "user", content: "hello" }], "fun-model"),
    ).resolves.toMatchObject({ content: "recovered" });
    expect(requests).toBe(2);
    expect(retryAfterMilliseconds("2.5", 0)).toBe(2_500);
    expect(
      retryAfterMilliseconds("Thu, 01 Jan 1970 00:00:05 GMT", 1_000),
    ).toBe(4_000);
  });

  test("preserves parallel tool calls and sends the documented tool controls", async () => {
    const endpoint = startServer(async (request) => {
      const body = (await request.json()) as Record<string, unknown>;
      expect(body.tool_choice).toBe("auto");
      expect(body.parallel_tool_calls).toBe(true);
      expect(body.tools).toEqual([
        {
          type: "function",
          function: {
            name: "memory_search",
            description: "Search durable memory",
            parameters: {
              type: "object",
              properties: { query: { type: "string" } },
              required: ["query"],
              additionalProperties: false,
            },
          },
        },
      ]);
      return Response.json({
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              content: null,
              tool_calls: [
                {
                  id: "call_memory",
                  type: "function",
                  function: {
                    name: "memory_search",
                    arguments: '{"query":"project atlas"}',
                  },
                },
                {
                  id: "call_web",
                  type: "function",
                  function: {
                    name: "web_search",
                    arguments: '{"query":"latest project atlas release"}',
                  },
                },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 20, completion_tokens: 8 },
      });
    });
    const client = new AIClient({
      endpoint,
      apiKey: "local-test-key",
      maxTokens: 2_400,
      logger: pino({ level: "silent" }),
      maxRetries: 0,
    });
    const result = await client.completeToolTurn(
      [{ role: "user", content: "what changed since our atlas plan?" }],
      "fun-model",
      [
        {
          type: "function",
          function: {
            name: "memory_search",
            description: "Search durable memory",
            parameters: {
              type: "object",
              properties: { query: { type: "string" } },
              required: ["query"],
              additionalProperties: false,
            },
          },
        },
      ],
    );

    expect(result.content).toBeUndefined();
    expect(result.toolCalls.map((call) => call.function.name)).toEqual([
      "memory_search",
      "web_search",
    ]);
    expect(result.assistantMessage).toEqual({
      role: "assistant",
      content: null,
      tool_calls: result.toolCalls,
    });
    expect(result.promptTokens).toBe(20);
    expect(result.completionTokens).toBe(8);
  });

  test("accepts tool outputs on the next agent turn", async () => {
    const endpoint = startServer(async (request) => {
      const body = (await request.json()) as {
        messages: Array<Record<string, unknown>>;
      };
      expect(body.messages.at(-1)).toEqual({
        role: "tool",
        tool_call_id: "call_memory",
        name: "memory_search",
        content: '{"memories":[]}',
      });
      return Response.json({
        choices: [
          {
            finish_reason: "stop",
            message: { content: "nothing durable matched." },
          },
        ],
      });
    });
    const client = new AIClient({
      endpoint,
      apiKey: "local-test-key",
      maxTokens: 2_400,
      logger: pino({ level: "silent" }),
      maxRetries: 0,
    });
    await expect(
      client.completeToolTurn(
        [
          { role: "user", content: "remember anything about atlas?" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_memory",
                type: "function",
                function: {
                  name: "memory_search",
                  arguments: '{"query":"atlas"}',
                },
              },
            ],
          },
          {
            role: "tool",
            tool_call_id: "call_memory",
            name: "memory_search",
            content: '{"memories":[]}',
          },
        ],
        "fun-model",
        [],
      ),
    ).resolves.toMatchObject({
      content: "nothing durable matched.",
      toolCalls: [],
    });
  });
});
