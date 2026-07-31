import { afterEach, describe, expect, test } from "bun:test";
import pino from "pino";
import {
  EmbeddingProviderError,
  OpenAIEmbeddingClient,
} from "../src/ai/embeddings.ts";

let server: Bun.Server<undefined> | undefined;

afterEach(() => {
  server?.stop(true);
  server = undefined;
});

function startServer(
  handler: (request: Request) => Response | Promise<Response>,
): string {
  server = Bun.serve({ port: 0, fetch: handler });
  return `http://127.0.0.1:${server.port}/v1/embeddings`;
}

function vector(seed: number): number[] {
  return Array.from({ length: 1_024 }, (_, index) =>
    index === seed ? 1 : 0,
  );
}

describe("OpenAI-compatible embeddings", () => {
  test("batches inputs, requests 1024 dimensions, and restores input order", async () => {
    const endpoint = startServer(async (request) => {
      expect(request.headers.get("authorization")).toBe("Bearer embedding-key");
      const body = (await request.json()) as Record<string, unknown>;
      expect(body).toMatchObject({
        model: "text-embedding-3-large",
        input: ["alpha", "beta"],
        dimensions: 1_024,
        encoding_format: "float",
      });
      return Response.json({
        object: "list",
        data: [
          { object: "embedding", index: 1, embedding: vector(1) },
          { object: "embedding", index: 0, embedding: vector(0) },
        ],
        usage: { prompt_tokens: 7, total_tokens: 7 },
      });
    });
    const client = new OpenAIEmbeddingClient({
      endpoint,
      apiKey: "embedding-key",
      model: "text-embedding-3-large",
      dimensions: 1_024,
      logger: pino({ level: "silent" }),
      maxRetries: 0,
    });

    const result = await client.embed([" alpha ", "beta"]);
    expect(result.promptTokens).toBe(7);
    expect(result.vectors[0]?.[0]).toBe(1);
    expect(result.vectors[1]?.[1]).toBe(1);
  });

  test("rejects missing or wrong-sized vectors", async () => {
    const endpoint = startServer(() =>
      Response.json({
        data: [{ index: 0, embedding: [1, 2, 3] }],
      }),
    );
    const client = new OpenAIEmbeddingClient({
      endpoint,
      apiKey: "embedding-key",
      model: "text-embedding-3-large",
      dimensions: 1_024,
      logger: pino({ level: "silent" }),
      maxRetries: 0,
    });
    await expect(client.embed(["alpha"])).rejects.toBeInstanceOf(
      EmbeddingProviderError,
    );
  });

  test("aborts an in-flight request without retrying it", async () => {
    const endpoint = startServer(
      async () => await new Promise<Response>(() => undefined),
    );
    const client = new OpenAIEmbeddingClient({
      endpoint,
      apiKey: "embedding-key",
      model: "text-embedding-3-large",
      dimensions: 1_024,
      logger: pino({ level: "silent" }),
      timeoutMs: 10_000,
      maxRetries: 2,
    });
    const controller = new AbortController();
    const pending = client.embed(["alpha"], controller.signal);
    controller.abort("test");
    await expect(pending).rejects.toMatchObject({ retryable: false });
  });
});
