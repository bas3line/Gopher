import type { EmbeddingProvider } from "../ai/embeddings.ts";
import type { Logger } from "../logger.ts";
import type { MemoryStore } from "./store.ts";
import type { MemoryEmbeddingJob } from "./types.ts";

export class MemoryEmbeddingWorker {
  private controller: AbortController | undefined;
  private running: Promise<void> | undefined;

  constructor(
    private readonly dependencies: {
      store: MemoryStore;
      embedding: EmbeddingProvider;
      logger: Logger;
      batchSize?: number;
      idlePollMs?: number;
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
    while (!signal.aborted) {
      let jobs: MemoryEmbeddingJob[] = [];
      try {
        jobs = await this.dependencies.store.claimMemoryEmbeddingJobs(
          this.dependencies.batchSize ?? 64,
          this.dependencies.embedding.model,
        );
        if (jobs.length === 0) {
          await abortableSleep(
            this.dependencies.idlePollMs ?? 1_000,
            signal,
          );
          continue;
        }
        await this.process(jobs, signal);
      } catch (error) {
        if (signal.aborted) return;
        this.dependencies.logger.warn(
          {
            err:
              error instanceof Error
                ? { name: error.name, message: error.message }
                : "unknown embedding worker error",
            memoryItemIds: jobs.map((job) => job.memoryItemId),
          },
          "memory embedding worker iteration failed",
        );
        if (jobs.length > 0) {
          await this.dependencies.store
            .failMemoryEmbeddingJobs(jobs, errorCode(error))
            .catch((failure) => {
              this.dependencies.logger.error(
                { err: failure },
                "could not release failed memory embedding jobs",
              );
            });
          await this.recordEvent(jobs[0], false, 0).catch(() => undefined);
        } else {
          await abortableSleep(1_000, signal);
        }
      }
    }
  }

  private async process(
    jobs: MemoryEmbeddingJob[],
    signal: AbortSignal,
  ): Promise<void> {
    const startedAt = performance.now();
    const result = await this.dependencies.embedding.embed(
      jobs.map(
        (job) =>
          `memory kind: ${job.kind}\nmemory key: ${job.key}\ncontent: ${job.content}`,
      ),
      signal,
    );
    const completed =
      await this.dependencies.store.finishMemoryEmbeddingJobs({
        jobs,
        vectors: result.vectors,
        model: this.dependencies.embedding.model,
      });
    this.dependencies.logger.debug(
      {
        claimed: jobs.length,
        completed,
        model: this.dependencies.embedding.model,
      },
      "durable memories embedded",
    );
    await this.recordEvent(
      jobs[0],
      true,
      Math.round(performance.now() - startedAt),
      result.promptTokens,
    );
  }

  private async recordEvent(
    job: MemoryEmbeddingJob | undefined,
    success: boolean,
    latencyMs: number,
    promptTokens?: number,
  ): Promise<void> {
    if (!job) return;
    await this.dependencies.store.recordAIEvent({
      guildId: job.guildId,
      channelId: job.channelId,
      userId: "system",
      model: this.dependencies.embedding.model,
      kind: "memory_embed",
      success,
      latencyMs,
      ...(promptTokens !== undefined ? { promptTokens } : {}),
    });
  }
}

function errorCode(error: unknown): string {
  return error instanceof Error
    ? error.name.toLocaleLowerCase("en")
    : "unknown";
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
