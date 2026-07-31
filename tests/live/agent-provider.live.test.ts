import { expect, test } from "bun:test";
import pino from "pino";
import { z } from "zod";
import { AgentLoop } from "../../src/agent/loop.ts";
import type { AgentTool } from "../../src/agent/types.ts";
import { AIClient } from "../../src/ai/client.ts";
import { normalizeChatCompletionsUrl } from "../../src/config.ts";

const enabled = process.env.RUN_LIVE_AGENT_TEST === "1";

test.skipIf(!enabled)(
  "live provider completes a real tool-call round trip",
  async () => {
    const endpoint = process.env.TEXT_API_URL;
    const apiKey = process.env.TEXT_API_KEY;
    const model = process.env.TEXT_MODEL ?? "FW-GLM-5.2";
    if (!endpoint || !apiKey) {
      throw new Error("live text-provider environment is incomplete");
    }
    const logger = pino({ level: "silent" });
    const client = new AIClient({
      endpoint: normalizeChatCompletionsUrl(endpoint),
      apiKey,
      maxTokens: Number(process.env.TEXT_MAX_TOKENS ?? 16_384),
      reasoningEffort: "none",
      logger,
      maxRetries: 1,
    });
    const tool: AgentTool<Record<string, never>, { value: string }> = {
      name: "echo_lookup",
      description:
        "Return the exact supplied value. This must be called before answering.",
      parameters: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
        additionalProperties: false,
      },
      schema: z.object({ value: z.string().min(1) }).strict(),
      effect: "read",
      parallelSafe: true,
      async execute(arguments_) {
        return { observed: arguments_.value };
      },
    };
    const result = await new AgentLoop({
      client,
      model,
      tools: [tool],
      logger,
      options: {
        maxIterations: 4,
        maxToolCalls: 4,
        runTimeoutMs: 90_000,
      },
    }).run({
      messages: [
        {
          role: "system",
          content:
            "Call echo_lookup with value provider-tool-smoke before answering. After the tool result, reply with exactly: agent tool smoke passed",
        },
        {
          role: "user",
          content: "Run the required tool-call smoke test.",
        },
      ],
      context: {},
    });

    expect(result.executions).toHaveLength(1);
    expect(result.executions[0]).toMatchObject({
      name: "echo_lookup",
      success: true,
    });
    expect(result.content.toLowerCase()).toContain("agent tool smoke passed");
  },
  100_000,
);
