import type { Logger } from "../logger.ts";
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
      let job: MemoryIngestionJob | undefined;
      try {
        job = await this.dependencies.store.claimMemoryIngestionJob();
        if (!job) {
          await abortableSleep(
            this.dependencies.idlePollMs ?? 750,
            signal,
          );
          continue;
        }
        await this.process(job);
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
          await this.dependencies.store
            .failMemoryIngestionJob(job, errorCode(error))
            .catch((failure) => {
              this.dependencies.logger.error(
                { err: failure, jobId: job?.id },
                "could not release failed memory ingestion job",
              );
            });
        } else {
          await abortableSleep(1_000, signal);
        }
      }
    }
  }

  private async process(job: MemoryIngestionJob): Promise<void> {
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
      return;
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
    const lastMessage = batch.messages.at(-1);
    if (!lastMessage) return;
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
  }
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
