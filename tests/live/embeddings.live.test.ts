import { expect, test } from "bun:test";
import pino from "pino";
import { OpenAIEmbeddingClient } from "../../src/ai/embeddings.ts";
import { normalizeEmbeddingsUrl } from "../../src/config.ts";

const enabled = process.env.RUN_LIVE_EMBEDDING_TEST === "1";

test.skipIf(!enabled)(
  "live embedding provider returns a 1024-dimensional vector",
  async () => {
    const endpoint = process.env.EMBEDDING_API_URL;
    const apiKey = process.env.EMBEDDING_API_KEY;
    const model = process.env.EMBEDDING_MODEL;
    if (!endpoint || !apiKey || !model) {
      throw new Error("live embedding-provider environment is incomplete");
    }
    const client = new OpenAIEmbeddingClient({
      endpoint: normalizeEmbeddingsUrl(endpoint),
      apiKey,
      model,
      dimensions: 1_024,
      logger: pino({ level: "silent" }),
      maxRetries: 1,
    });
    const result = await client.embed([
      "Gopher durable semantic memory smoke test",
    ]);
    expect(result.vectors).toHaveLength(1);
    expect(result.vectors[0]).toHaveLength(1_024);
    expect(result.vectors[0]?.every(Number.isFinite)).toBeTrue();
  },
  60_000,
);
