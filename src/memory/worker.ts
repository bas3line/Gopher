import type { Logger } from "../logger.ts";
import type { Semaphore } from "../infra/coordinator.ts";
import { MemoryExtractor, MemoryExtractionError } from "./extractor.ts";
import { MemoryStore } from "./store.ts";
import type { MemoryIngestionJob } from "./types.ts";

export class MemoryWorker {
  private controller: AbortController | undefined;
  private running: Promise<void> | undefined;

  constructor(
    private readonly dependencies: {
      store: MemoryStore;
      extractor: MemoryExtractor;
      model: string;
      logger: Logger;
      semaphore: Semaphore;
      batchSize?: number;
      idlePollMs?: number;
      startupDelayMs?: number;
      successIntervalMs?: number;
    },
  ) {}

  start(): void {
    if (this.running) return;
    this.controller = new AbortController();
    this.running = this.loop(this.controller.signal).finally(() => {
      this.running = undefined;
      this.controller = undefined;
    });
  }

  async stop(): Promise<void> {
    this.controller?.abort();
    await this.running;
  }

  private async loop(signal: AbortSignal): Promise<void> {
    const startupDelayMs = this.dependencies.startupDelayMs ?? 0;
    let consecutiveProviderFailures = 0;
    if (startupDelayMs > 0) {
      await abortableSleep(startupDelayMs, signal);
    }
    while (!signal.aborted) {
      let job: MemoryIngestionJob | undefined;
      let providerCallSucceeded = false;
      try {
        await this.dependencies.semaphore.use(
          async () => {
            job = await this.dependencies.store.claimMemoryIngestionJob();
            if (job) providerCallSucceeded = await this.process(job);
          },
          signal,
          -1,
        );
        if (!job) {
          await abortableSleep(
            this.dependencies.idlePollMs ?? 750,
            signal,
          );
          continue;
        }
        if (providerCallSucceeded) consecutiveProviderFailures = 0;
        await abortableSleep(
          this.dependencies.successIntervalMs ?? 5_000,
          signal,
        );
      } catch (error) {
        if (signal.aborted) return;
        this.dependencies.logger.warn(
          {
            err:
              error instanceof Error
                ? { name: error.name, message: error.message }
                : "unknown memory worker error",
            jobId: job?.id,
          },
          "memory consolidation worker iteration failed",
        );
        if (job) {
          const providerFailure =
            error instanceof MemoryExtractionError &&
            error.code === "provider_failure";
          consecutiveProviderFailures = providerFailure
            ? consecutiveProviderFailures + 1
            : 0;
          const policy = memoryFailurePolicy(
            error,
            job.attempts,
            consecutiveProviderFailures,
          );
          await this.dependencies.store
            .failMemoryIngestionJob(job, errorCode(error), {
              maxAttempts: policy.maxAttempts,
              retryDelayMs: policy.retryDelayMs,
            })
            .catch((failure) => {
              this.dependencies.logger.error(
                { err: failure, jobId: job?.id },
                "could not release failed memory ingestion job",
              );
            });
          await abortableSleep(policy.workerCooldownMs, signal);
        } else {
          await abortableSleep(1_000, signal);
        }
      }
    }
  }

  private async process(job: MemoryIngestionJob): Promise<boolean> {
    const batch = await this.dependencies.store.memoryIngestionBatch(
      job,
      this.dependencies.batchSize ?? 32,
    );
    if (batch.messages.length === 0) {
      await this.dependencies.store.finishMemoryIngestion({
        job,
        lastProcessedMessageId: Math.max(
          batch.checkpoint,
          job.throughMessageId,
        ),
        reachedTarget: true,
      });
      return false;
    }

    const startedAt = performance.now();
    const extraction = await this.dependencies.extractor.extract({
      messages: batch.messages,
      existing: batch.existing,
      knownUserIds: batch.knownUserIds,
    });
    await this.dependencies.store.upsertMemories({
      guildId: job.guildId,
      channelId: job.channelId,
      candidates: extraction.candidates,
      source: "extracted",
    });
    await this.dependencies.store.upsertMemoryLinks({
      guildId: job.guildId,
      channelId: job.channelId,
      relations: extraction.relations,
    });
    const lastMessage = batch.messages.at(-1);
    if (!lastMessage) {
      throw new Error("memory ingestion batch lost its final message");
    }
    await this.dependencies.store.finishMemoryIngestion({
      job,
      lastProcessedMessageId: lastMessage.id,
      reachedTarget: batch.reachedTarget,
    });
    await this.dependencies.store.recordAIEvent({
      guildId: job.guildId,
      channelId: job.channelId,
      userId: "system",
      model: this.dependencies.model,
      kind: "memory_extract",
      success: true,
      latencyMs: Math.round(performance.now() - startedAt),
      ...(extraction.promptTokens !== undefined
        ? { promptTokens: extraction.promptTokens }
        : {}),
      ...(extraction.completionTokens !== undefined
        ? { completionTokens: extraction.completionTokens }
        : {}),
    });
    return true;
  }
}

export interface MemoryFailurePolicy {
  maxAttempts: number;
  retryDelayMs: number;
  workerCooldownMs: number;
}

export function memoryFailurePolicy(
  error: unknown,
  attempts: number,
  consecutiveProviderFailures = attempts,
): MemoryFailurePolicy {
  const boundedAttempt = Math.max(1, Math.min(attempts, 20));
  if (error instanceof MemoryExtractionError) {
    if (error.code === "provider_failure") {
      const boundedFailureStreak = Math.max(
        1,
        Math.min(consecutiveProviderFailures, 20),
      );
      const exponentialDelay = 30_000 * 2 ** (boundedFailureStreak - 1);
      const delay = clampDelay(
        Math.max(exponentialDelay, error.retryAfterMs ?? 0),
        30_000,
        300_000,
      );
      return {
        maxAttempts: 20,
        retryDelayMs: delay,
        workerCooldownMs: delay,
      };
    }
    if (error.code === "invalid_output") {
      const delay = clampDelay(
        15_000 * 2 ** (boundedAttempt - 1),
        15_000,
        300_000,
      );
      return {
        maxAttempts: 3,
        retryDelayMs: delay,
        workerCooldownMs: Math.min(delay, 60_000),
      };
    }
    return { maxAttempts: 1, retryDelayMs: 60_000, workerCooldownMs: 60_000 };
  }
  return { maxAttempts: 5, retryDelayMs: 30_000, workerCooldownMs: 30_000 };
}

function clampDelay(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return maximum;
  return Math.round(Math.max(minimum, Math.min(value, maximum)));
}

function errorCode(error: unknown): string {
  if (error instanceof MemoryExtractionError) return error.code;
  if (error instanceof Error) return error.name.toLowerCase();
  return "unknown";
}

function abortableSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = setTimeout(done, milliseconds);
    signal.addEventListener("abort", done, { once: true });
    function done() {
      clearTimeout(timeout);
      signal.removeEventListener("abort", done);
      resolve();
    }
  });
}
