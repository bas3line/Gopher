import { afterEach, describe, expect, test } from "bun:test";
import pino from "pino";
import { CloudflareAIClient } from "../src/ai/cloudflare.ts";

let server: Bun.Server<undefined> | undefined;
afterEach(() => {
  server?.stop(true);
  server = undefined;
});

describe("Cloudflare Workers AI client", () => {
  test("calls the account-scoped model endpoint and parses the API envelope", async () => {
    server = Bun.serve({
      port: 0,
      async fetch(request) {
        expect(new URL(request.url).pathname).toBe(
          "/accounts/0123456789abcdef0123456789abcdef/ai/run/@cf/zai-org/glm-5.2",
        );
        expect(request.headers.get("authorization")).toBe("Bearer cloudflare-test-token");
        const body = (await request.json()) as Record<string, unknown>;
        expect(body.max_tokens).toBe(2_400);
        expect(body.stream).toBeFalse();
        return Response.json({
          success: true,
          errors: [],
          messages: [],
          result: {
            choices: [
              {
                message: {
                  role: "assistant",
                  content: "private reasoning</think>  cloudflare cooked  ",
                },
              },
            ],
            usage: { prompt_tokens: 20, completion_tokens: 6, total_tokens: 26 },
          },
        });
      },
    });

    const client = new CloudflareAIClient({
      accountId: "0123456789abcdef0123456789abcdef",
      apiToken: "cloudflare-test-token",
      maxTokens: 2_400,
      logger: pino({ level: "silent" }),
      apiBaseUrl: `http://127.0.0.1:${server.port}`,
      maxRetries: 0,
    });
    await expect(
      client.complete([{ role: "user", content: "hello" }], "@cf/zai-org/glm-5.2"),
    ).resolves.toEqual({
      content: "cloudflare cooked",
      promptTokens: 20,
      completionTokens: 6,
    });
  });

  test("rejects images on the text-only path", async () => {
    const client = new CloudflareAIClient({
      accountId: "0123456789abcdef0123456789abcdef",
      apiToken: "cloudflare-test-token",
      maxTokens: 2_400,
      logger: pino({ level: "silent" }),
      maxRetries: 0,
    });
    await expect(
      client.complete(
        [
          {
            role: "user",
            content: [
              { type: "text", text: "what is this" },
              { type: "image_url", image_url: { url: "https://example.com/image.png", detail: "high" } },
            ],
          },
        ],
        "@cf/zai-org/glm-5.2",
      ),
    ).rejects.toThrow("cannot contain images");
  });

  test("rejects token-truncated answers instead of sending partial code", async () => {
    server = Bun.serve({
      port: 0,
      fetch() {
        return Response.json({
          success: true,
          errors: [],
          result: {
            choices: [
              {
                finish_reason: "length",
                message: { content: "```go\npackage main\nfunc main() {" },
              },
            ],
          },
        });
      },
    });
    const client = new CloudflareAIClient({
      accountId: "0123456789abcdef0123456789abcdef",
      apiToken: "cloudflare-test-token",
      maxTokens: 2_400,
      logger: pino({ level: "silent" }),
      apiBaseUrl: `http://127.0.0.1:${server.port}`,
      maxRetries: 0,
    });

    await expect(
      client.complete([{ role: "user", content: "finish the code" }], "@cf/zai-org/glm-5.2"),
    ).rejects.toThrow("before completing the response");
  });
});
