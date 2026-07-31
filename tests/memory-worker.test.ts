import { describe, expect, test } from "bun:test";
import { MemoryExtractionError } from "../src/memory/extractor.ts";
import { memoryFailurePolicy } from "../src/memory/worker.ts";

describe("memory worker provider isolation", () => {
  test("uses provider retry guidance as a worker-wide cooldown", () => {
    expect(
      memoryFailurePolicy(
        new MemoryExtractionError(
          "Memory provider failed: HTTP 429",
          "provider_failure",
          120_000,
        ),
        1,
      ),
    ).toEqual({
      maxAttempts: 20,
      retryDelayMs: 120_000,
      workerCooldownMs: 120_000,
    });
  });

  test("backs off provider failures exponentially instead of retrying every job", () => {
    expect(
      memoryFailurePolicy(
        new MemoryExtractionError(
          "Memory provider failed",
          "provider_failure",
        ),
        1,
      ).retryDelayMs,
    ).toBe(30_000);
    expect(
      memoryFailurePolicy(
        new MemoryExtractionError(
          "Memory provider failed",
          "provider_failure",
        ),
        1,
        4,
      ).retryDelayMs,
    ).toBe(240_000);
    expect(
      memoryFailurePolicy(
        new MemoryExtractionError(
          "Memory provider failed",
          "provider_failure",
          5_000,
        ),
        1,
        3,
      ).retryDelayMs,
    ).toBe(120_000);
  });

  test("bounds malformed output retries separately from transient outages", () => {
    const policy = memoryFailurePolicy(
      new MemoryExtractionError("invalid shape", "invalid_output"),
      2,
    );
    expect(policy).toEqual({
      maxAttempts: 3,
      retryDelayMs: 30_000,
      workerCooldownMs: 30_000,
    });
    expect(memoryFailurePolicy(new Error("database unavailable"), 1)).toEqual({
      maxAttempts: 5,
      retryDelayMs: 30_000,
      workerCooldownMs: 30_000,
    });
  });
});
