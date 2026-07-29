import { expect, test } from "bun:test";
import pino from "pino";
import { AIClient } from "../../src/ai/client.ts";
import { normalizeChatCompletionsUrl } from "../../src/config.ts";

const enabled = process.env.RUN_LIVE_PROVIDER_TEST === "1";

test.skipIf(!enabled)("live provider returns a final answer", async () => {
  const endpoint = process.env.TEXT_API_URL;
  const apiKey = process.env.TEXT_API_KEY;
  const model = process.env.TEXT_MODEL ?? "FW-GLM-5.2";
  if (!endpoint || !apiKey)
    throw new Error("live text-provider environment is incomplete");

  const client = new AIClient({
    endpoint: normalizeChatCompletionsUrl(endpoint),
    apiKey,
    maxTokens: Number(process.env.TEXT_MAX_TOKENS ?? 2_400),
    reasoningEffort: "none",
    logger: pino({ level: "silent" }),
    maxRetries: 1,
  });
  const response = await client.complete(
    [
      {
        role: "user",
        content: "Reply with exactly: provider smoke test passed",
      },
    ],
    model,
  );
  expect(response.content.toLowerCase()).toContain(
    "provider smoke test passed",
  );
});
