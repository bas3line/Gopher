import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import pino from "pino";
import type { DatabasePool } from "../../src/db/pool.ts";
import { createDatabasePool } from "../../src/db/pool.ts";
import { migrate } from "../../src/db/migrate.ts";
import { MemoryStore } from "../../src/memory/store.ts";

const runIntegrationTests = process.env.RUN_INTEGRATION_TESTS === "1";

describe.skipIf(!runIntegrationTests)(
  "PostgreSQL agent memory integration",
  () => {
    let pool: DatabasePool;
    let memory: MemoryStore;

    beforeAll(async () => {
      const databaseUrl = process.env.DATABASE_URL;
      if (!databaseUrl) {
        throw new Error("DATABASE_URL is required for integration tests");
      }
      pool = createDatabasePool(
        databaseUrl,
        pino({ level: "silent" }),
      );
      await migrate(pool);
      memory = new MemoryStore(pool);
    });

    beforeEach(async () => {
      await pool.query(`
        TRUNCATE TABLE
          agent_action_receipts,
          agent_tool_calls,
          agent_runs,
          memory_embedding_jobs,
          memory_link_revisions,
          memory_links,
          memory_item_revisions,
          memory_items,
          memory_ingestion_jobs,
          memory_channel_checkpoints,
          discord_events,
          chat_message_revisions,
          conversation_summaries,
          web_documents,
          ai_events,
          chat_messages
        RESTART IDENTITY CASCADE
      `);
    });

    afterAll(async () => {
      await pool?.end();
    });

    test("journals messages, revisions, deletion, and durable ingestion work", async () => {
      const createdAt = new Date("2026-07-31T01:00:00.000Z");
      const id = await memory.recordMessage({
        discordMessageId: "discord-message-1",
        guildId: "guild-1",
        channelId: "channel-1",
        userId: "user-1",
        username: "Kira",
        role: "user",
        content: "Remember that Atlas uses PostgreSQL.",
        createdAt,
      });
      expect(id).toBe(1);
      await expect(
        memory.recordMessage({
          discordMessageId: "discord-message-1",
          guildId: "guild-1",
          channelId: "channel-1",
          userId: "user-1",
          username: "Kira",
          role: "user",
          content: "duplicate",
        }),
      ).resolves.toBeUndefined();

      const counts = await pool.query<{
        messages: string;
        events: string;
        jobs: string;
      }>(`
        SELECT
          (SELECT count(*) FROM chat_messages) AS messages,
          (SELECT count(*) FROM discord_events) AS events,
          (SELECT count(*) FROM memory_ingestion_jobs) AS jobs
      `);
      expect(counts.rows[0]).toEqual({
        messages: "1",
        events: "1",
        jobs: "1",
      });

      const job = await memory.claimMemoryIngestionJob();
      expect(job).toMatchObject({
        guildId: "guild-1",
        channelId: "channel-1",
        throughMessageId: 1,
        attempts: 1,
      });
      const batch = await memory.memoryIngestionBatch(job!, 32);
      expect(batch.messages.map((message) => message.content)).toEqual([
        "Remember that Atlas uses PostgreSQL.",
      ]);
      expect(batch.knownUserIds).toEqual(["user-1"]);
      expect(batch.reachedTarget).toBeTrue();
      await memory.finishMemoryIngestion({
        job: job!,
        lastProcessedMessageId: 1,
        reachedTarget: true,
      });
      const finished = await pool.query<{
        status: string;
        checkpoint: string;
      }>(`
        SELECT
          jobs.status,
          checkpoints.last_message_id AS checkpoint
        FROM memory_ingestion_jobs AS jobs
        INNER JOIN memory_channel_checkpoints AS checkpoints
          USING (guild_id, channel_id)
      `);
      expect(finished.rows[0]).toEqual({
        status: "completed",
        checkpoint: "1",
      });

      await expect(
        memory.recordMessageEdit({
          discordMessageId: "discord-message-1",
          guildId: "guild-1",
          channelId: "channel-1",
          actorUserId: "user-1",
          replacementContent: "Atlas uses PostgreSQL 17.",
          editedAt: new Date("2026-07-31T01:05:00.000Z"),
        }),
      ).resolves.toBeTrue();
      const edited = await pool.query<{
        content: string;
        revisions: string;
        checkpoint: string;
        job_status: string;
      }>(`
        SELECT
          messages.content,
          (SELECT count(*) FROM chat_message_revisions) AS revisions,
          checkpoints.last_message_id AS checkpoint,
          jobs.status AS job_status
        FROM chat_messages AS messages
        INNER JOIN memory_channel_checkpoints AS checkpoints
          USING (guild_id, channel_id)
        INNER JOIN memory_ingestion_jobs AS jobs
          ON jobs.through_message_id = messages.id
      `);
      expect(edited.rows[0]).toEqual({
        content: "Atlas uses PostgreSQL 17.",
        revisions: "1",
        checkpoint: "0",
        job_status: "pending",
      });

      await expect(
        memory.recordMessageDeletion({
          discordMessageId: "discord-message-1",
          guildId: "guild-1",
          channelId: "channel-1",
          actorUserId: "user-1",
          deletedAt: new Date("2026-07-31T01:10:00.000Z"),
        }),
      ).resolves.toBeTrue();
      const deletion = await pool.query<{
        deleted: boolean;
        delete_events: string;
      }>(`
        SELECT
          deleted_at IS NOT NULL AS deleted,
          (
            SELECT count(*)
            FROM discord_events
            WHERE event_type = 'message_delete'
          ) AS delete_events
        FROM chat_messages
      `);
      expect(deletion.rows[0]).toEqual({
        deleted: true,
        delete_events: "1",
      });
    });

    test("backs off transient memory-provider failures without exhausting the job", async () => {
      await memory.recordMessage({
        discordMessageId: "provider-backoff-1",
        guildId: "guild-1",
        channelId: "channel-1",
        userId: "user-1",
        username: "Kira",
        role: "user",
        content: "Atlas uses PostgreSQL.",
      });
      const job = await memory.claimMemoryIngestionJob();
      expect(job).toBeDefined();
      await memory.failMemoryIngestionJob(job!, "provider_failure", {
        maxAttempts: 20,
        retryDelayMs: 120_000,
      });
      const pending = await pool.query<{
        status: string;
        last_error_code: string;
        delay_seconds: number;
      }>(`
        SELECT
          status,
          last_error_code,
          EXTRACT(EPOCH FROM (available_at - now()))::float AS delay_seconds
        FROM memory_ingestion_jobs
        WHERE id = $1
      `, [job!.id]);
      expect(pending.rows[0]?.status).toBe("pending");
      expect(pending.rows[0]?.last_error_code).toBe("provider_failure");
      expect(pending.rows[0]?.delay_seconds).toBeGreaterThan(110);

      await pool.query(
        "UPDATE memory_ingestion_jobs SET attempts = 20, status = 'processing' WHERE id = $1",
        [job!.id],
      );
      await memory.failMemoryIngestionJob(job!, "provider_failure", {
        maxAttempts: 20,
        retryDelayMs: 120_000,
      });
      const exhausted = await pool.query<{
        status: string;
        completed: boolean;
      }>(`
        SELECT status, completed_at IS NOT NULL AS completed
        FROM memory_ingestion_jobs
        WHERE id = $1
      `, [job!.id]);
      expect(exhausted.rows[0]).toEqual({ status: "failed", completed: true });
    });

    test("revises, scopes, retrieves, audits, and forgets typed memory", async () => {
      await memory.recordMessage({
        discordMessageId: "evidence-1",
        guildId: "guild-1",
        channelId: "channel-1",
        userId: "user-1",
        username: "Kira",
        role: "user",
        content: "I prefer Bun.",
      });
      const first = await memory.upsertMemories({
        guildId: "guild-1",
        channelId: "channel-1",
        source: "explicit",
        candidates: [
          {
            scope: "user",
            subjectUserId: "user-1",
            kind: "preference",
            key: "preference.runtime",
            content: "Kira prefers Bun.",
            importance: 8,
            confidence: 1,
            evidenceMessageIds: ["evidence-1"],
            reason: "Explicit user preference.",
          },
        ],
      });
      expect(first[0]).toMatchObject({
        id: 1,
        key: "preference.runtime",
        version: 1,
      });
      const confirmed = await memory.upsertMemories({
        guildId: "guild-1",
        channelId: "channel-1",
        source: "extracted",
        candidates: [
          {
            scope: "user",
            subjectUserId: "user-1",
            kind: "preference",
            key: "preference.runtime",
            content: "Kira prefers Bun.",
            importance: 7,
            confidence: 0.9,
            evidenceMessageIds: ["evidence-1"],
            reason: "Confirmed in a later consolidation pass.",
          },
        ],
      });
      expect(confirmed[0]?.version).toBe(1);

      const revised = await memory.upsertMemories({
        guildId: "guild-1",
        channelId: "channel-1",
        source: "explicit",
        candidates: [
          {
            scope: "user",
            subjectUserId: "user-1",
            kind: "preference",
            key: "preference.runtime",
            content: "Kira now prefers Node.js for Atlas.",
            importance: 9,
            confidence: 1,
            evidenceMessageIds: ["evidence-1"],
            reason: "The user corrected their runtime preference.",
          },
          {
            scope: "user",
            subjectUserId: "user-2",
            kind: "preference",
            key: "preference.runtime",
            content: "Another member prefers Deno.",
            importance: 6,
            confidence: 0.9,
            evidenceMessageIds: ["evidence-1"],
            reason: "Scope isolation fixture.",
          },
          {
            scope: "guild",
            kind: "decision",
            key: "project.atlas.database",
            content: "Project Atlas uses PostgreSQL.",
            importance: 10,
            confidence: 0.98,
            evidenceMessageIds: ["evidence-1"],
            reason: "Server-wide project decision.",
          },
        ],
      });
      expect(revised.find((item) => item.id === 1)).toMatchObject({
        content: "Kira now prefers Node.js for Atlas.",
        version: 2,
      });
      const revisions = await pool.query<{ count: string }>(
        "SELECT count(*) FROM memory_item_revisions WHERE memory_item_id = 1",
      );
      expect(revisions.rows[0]?.count).toBe("1");

      const recalled = await memory.recall({
        guildId: "guild-1",
        channelId: "channel-1",
        userId: "user-1",
        query: "Atlas runtime database",
        limit: 10,
      });
      expect(recalled.map((item) => item.content)).toContain(
        "Kira now prefers Node.js for Atlas.",
      );
      expect(recalled.map((item) => item.content)).toContain(
        "Project Atlas uses PostgreSQL.",
      );
      expect(recalled.map((item) => item.content)).not.toContain(
        "Another member prefers Deno.",
      );
      expect(recalled.every((item) => item.accessCount === 0)).toBeTrue();
      const accesses = await pool.query<{ access_count: number }>(
        "SELECT access_count FROM memory_items WHERE id = 1",
      );
      expect(accesses.rows[0]?.access_count).toBe(1);

      await expect(
        memory.forgetMemory({
          id: 1,
          guildId: "guild-1",
          requesterUserId: "user-2",
          allowGuildScope: false,
          reason: "Unauthorized fixture.",
        }),
      ).resolves.toBeFalse();
      await expect(
        memory.forgetMemory({
          id: 1,
          guildId: "guild-1",
          requesterUserId: "user-1",
          allowGuildScope: false,
          reason: "User asked to forget it.",
        }),
      ).resolves.toBeTrue();
      const afterForget = await memory.recall({
        guildId: "guild-1",
        channelId: "channel-1",
        userId: "user-1",
        query: "runtime preference",
        limit: 10,
      });
      expect(afterForget.map((item) => item.id)).not.toContain(1);

      const overview = await memory.memoryOverview({
        guildId: "guild-1",
        channelId: "channel-1",
        userId: "user-1",
      });
      expect(overview).toMatchObject({
        user: 0,
        guild: 1,
      });
    });

    test("persists agent-run and tool-call audit evidence", async () => {
      await memory.startAgentRun({
        id: "00000000-0000-4000-8000-000000000001",
        guildId: "guild-1",
        channelId: "channel-1",
        userId: "user-1",
        discordMessageId: "message-1",
        model: "agent-model",
      });
      await memory.recordAgentToolExecution(
        "00000000-0000-4000-8000-000000000001",
        {
          callId: "call-1",
          name: "memory_search",
          iteration: 1,
          effect: "read",
          success: true,
          cached: false,
          durationMs: 12,
          output: '{"ok":true}',
        },
      );
      await memory.finishAgentRun({
        id: "00000000-0000-4000-8000-000000000001",
        status: "completed",
        iterations: 2,
        toolCalls: 1,
        promptTokens: 200,
        completionTokens: 50,
      });
      await memory.recordAIEvent({
        guildId: "guild-1",
        channelId: "channel-1",
        userId: "user-1",
        model: "agent-model",
        kind: "agent",
        success: true,
        latencyMs: 100,
      });

      const audit = await pool.query<{
        status: string;
        iterations: number;
        tool_calls: number;
        tool_name: string;
        kind: string;
      }>(`
        SELECT
          runs.status,
          runs.iterations,
          runs.tool_calls,
          calls.tool_name,
          events.kind
        FROM agent_runs AS runs
        INNER JOIN agent_tool_calls AS calls ON calls.run_id = runs.id
        INNER JOIN ai_events AS events ON events.guild_id = runs.guild_id
      `);
      expect(audit.rows[0]).toEqual({
        status: "completed",
        iterations: 2,
        tool_calls: 1,
        tool_name: "memory_search",
        kind: "agent",
      });
    });

    test("embeds durable jobs and recalls semantically without leaking another user scope", async () => {
      const semanticMemory = new MemoryStore(pool, {
        embedding: {
          model: "embedding-test-model",
          dimensions: 1_024,
          async embed(inputs) {
            return {
              vectors: inputs.map(() => unitVector(0)),
              promptTokens: inputs.length,
            };
          },
        },
      });
      await semanticMemory.recordMessage({
        discordMessageId: "semantic-evidence",
        guildId: "guild-1",
        channelId: "channel-1",
        userId: "user-1",
        username: "Kira",
        role: "user",
        content: "My favorite animal is a cat.",
      });
      await semanticMemory.upsertMemories({
        guildId: "guild-1",
        channelId: "channel-1",
        source: "explicit",
        candidates: [
          {
            scope: "user",
            subjectUserId: "user-1",
            kind: "preference",
            key: "preference.animal",
            content: "Kira's favorite animal is a cat.",
            importance: 8,
            confidence: 1,
            evidenceMessageIds: ["semantic-evidence"],
            reason: "Explicit preference.",
          },
          {
            scope: "user",
            subjectUserId: "user-2",
            kind: "preference",
            key: "preference.animal",
            content: "Another member's favorite animal is a cat.",
            importance: 10,
            confidence: 1,
            evidenceMessageIds: ["semantic-evidence"],
            reason: "Scope isolation fixture.",
          },
          {
            scope: "guild",
            kind: "fact",
            key: "server.mascot",
            content: "The server mascot is an otter.",
            importance: 5,
            confidence: 1,
            evidenceMessageIds: ["semantic-evidence"],
            reason: "Orthogonal semantic fixture.",
          },
        ],
      });
      const jobs = await semanticMemory.claimMemoryEmbeddingJobs(
        10,
        "embedding-test-model",
      );
      expect(jobs).toHaveLength(3);
      await semanticMemory.finishMemoryEmbeddingJobs({
        jobs,
        vectors: jobs.map((job) =>
          job.key === "server.mascot" ? unitVector(1) : unitVector(0),
        ),
        model: "embedding-test-model",
      });

      const recalled = await semanticMemory.recall({
        guildId: "guild-1",
        channelId: "channel-1",
        userId: "user-1",
        query: "preferred household companion",
        limit: 1,
      });
      expect(recalled[0]).toMatchObject({
        key: "preference.animal",
        content: "Kira's favorite animal is a cat.",
        embeddingModel: "embedding-test-model",
      });
      expect(recalled[0]?.semanticSimilarity).toBeGreaterThan(0.99);
      expect(recalled.map((item) => item.content)).not.toContain(
        "Another member's favorite animal is a cat.",
      );
    });

    test("expands one grounded graph hop without crossing user scope and revokes deleted evidence", async () => {
      for (const message of [
        {
          discordMessageId: "graph-seed",
          userId: "user-1",
          content: "I work best in deep-focus blocks.",
        },
        {
          discordMessageId: "graph-project",
          userId: "user-1",
          content: "Project Aurora launches September ninth.",
        },
        {
          discordMessageId: "graph-link",
          userId: "user-1",
          content: "My focus routine is part of how I will deliver Aurora.",
        },
      ]) {
        await memory.recordMessage({
          ...message,
          guildId: "guild-1",
          channelId: "channel-1",
          username: "Kira",
          role: "user",
        });
      }
      const saved = await memory.upsertMemories({
        guildId: "guild-1",
        channelId: "channel-1",
        source: "explicit",
        candidates: [
          {
            scope: "user",
            subjectUserId: "user-1",
            kind: "preference",
            key: "preference.focus_routine",
            content: "Kira works best in deep-focus blocks.",
            importance: 8,
            confidence: 1,
            evidenceMessageIds: ["graph-seed"],
            reason: "Explicit working preference.",
          },
          {
            scope: "guild",
            kind: "project",
            key: "project.aurora.launch",
            content: "Project Aurora launches September ninth.",
            importance: 9,
            confidence: 0.98,
            evidenceMessageIds: ["graph-project"],
            reason: "Durable project milestone.",
          },
          {
            scope: "user",
            subjectUserId: "user-2",
            kind: "fact",
            key: "profile.playbook",
            content: "Another member owns the cobalt playbook.",
            importance: 10,
            confidence: 1,
            evidenceMessageIds: ["graph-project"],
            reason: "Scope-isolation fixture.",
          },
        ],
      });
      const seed = saved.find(
        (memory) => memory.key === "preference.focus_routine",
      )!;
      const project = saved.find(
        (memory) => memory.key === "project.aurora.launch",
      )!;
      await expect(
        memory.upsertMemoryLinks({
          guildId: "guild-1",
          channelId: "channel-1",
          relations: [
            {
              from: {
                scope: "user",
                subjectUserId: "user-1",
                kind: "preference",
                key: "preference.focus_routine",
              },
              to: {
                scope: "guild",
                kind: "project",
                key: "project.aurora.launch",
              },
              relation: "related_to",
              confidence: 0.94,
              evidenceMessageIds: ["graph-link"],
            },
            {
              from: {
                scope: "user",
                subjectUserId: "user-1",
                kind: "preference",
                key: "preference.focus_routine",
              },
              to: {
                scope: "user",
                subjectUserId: "user-2",
                kind: "fact",
                key: "profile.playbook",
              },
              relation: "related_to",
              confidence: 1,
              evidenceMessageIds: ["graph-link"],
            },
          ],
        }),
      ).resolves.toBe(2);

      const recalled = await memory.recall({
        guildId: "guild-1",
        channelId: "channel-1",
        userId: "user-1",
        query: "deep-focus blocks",
        limit: 10,
      });
      expect(recalled.map((item) => item.id)).toContain(seed.id);
      expect(recalled.map((item) => item.id)).toContain(project.id);
      expect(recalled.map((item) => item.content)).not.toContain(
        "Another member owns the cobalt playbook.",
      );
      expect(recalled.find((item) => item.id === project.id)).toMatchObject({
        linkedFromMemoryId: seed.id,
        linkRelation: "related_to",
        linkConfidence: 0.94,
        linkDirection: "outbound",
      });

      await memory.recordMessageDeletion({
        discordMessageId: "graph-link",
        guildId: "guild-1",
        channelId: "channel-1",
        actorUserId: "user-1",
        deletedAt: new Date("2026-07-31T03:00:00.000Z"),
      });
      const afterRevocation = await memory.recall({
        guildId: "guild-1",
        channelId: "channel-1",
        userId: "user-1",
        query: "deep-focus blocks",
        limit: 10,
      });
      expect(afterRevocation.map((item) => item.id)).toContain(seed.id);
      expect(afterRevocation.map((item) => item.id)).not.toContain(project.id);
      const linkAudit = await pool.query<{ count: string }>(
        "SELECT count(*) FROM memory_link_revisions",
      );
      expect(linkAudit.rows[0]?.count).toBe("2");
    });

    test("revokes stale derived memory when supporting Discord evidence is edited or deleted", async () => {
      await memory.recordMessage({
        discordMessageId: "mutable-evidence",
        guildId: "guild-1",
        channelId: "channel-1",
        userId: "user-1",
        username: "Kira",
        role: "user",
        content: "Atlas uses MongoDB.",
      });
      const saved = await memory.upsertMemories({
        guildId: "guild-1",
        channelId: "channel-1",
        source: "extracted",
        candidates: [
          {
            scope: "guild",
            kind: "decision",
            key: "project.atlas.database",
            content: "Atlas uses MongoDB.",
            importance: 9,
            confidence: 0.95,
            evidenceMessageIds: ["mutable-evidence"],
            reason: "Initial message.",
          },
        ],
      });
      await memory.recordMessageEdit({
        discordMessageId: "mutable-evidence",
        guildId: "guild-1",
        channelId: "channel-1",
        actorUserId: "user-1",
        replacementContent: "Atlas uses PostgreSQL.",
        editedAt: new Date("2026-07-31T02:00:00.000Z"),
      });
      expect(
        (
          await memory.recall({
            guildId: "guild-1",
            channelId: "channel-1",
            userId: "user-1",
            query: "Atlas MongoDB",
            limit: 10,
          })
        ).map((item) => item.id),
      ).not.toContain(saved[0]?.id);

      const replacement = await memory.upsertMemories({
        guildId: "guild-1",
        channelId: "channel-1",
        source: "extracted",
        candidates: [
          {
            scope: "guild",
            kind: "decision",
            key: "project.atlas.database",
            content: "Atlas uses PostgreSQL.",
            importance: 9,
            confidence: 0.98,
            evidenceMessageIds: ["mutable-evidence"],
            reason: "Edited message.",
          },
        ],
      });
      await memory.recordMessageDeletion({
        discordMessageId: "mutable-evidence",
        guildId: "guild-1",
        channelId: "channel-1",
        actorUserId: "user-1",
        deletedAt: new Date("2026-07-31T02:05:00.000Z"),
      });
      expect(
        (
          await memory.recall({
            guildId: "guild-1",
            channelId: "channel-1",
            userId: "user-1",
            query: "Atlas PostgreSQL",
            limit: 10,
          })
        ).map((item) => item.id),
      ).not.toContain(replacement[0]?.id);
      expect(await memory.recent("guild-1", "channel-1", 10)).toEqual([]);
    });

    test("claims Discord side effects once and replays their durable receipt", async () => {
      const identity = {
        requestDiscordMessageId: "request-1",
        toolName: "discord_send_message",
        argumentsHash: "a".repeat(64),
        runId: "00000000-0000-4000-8000-000000000001",
        callId: "call-1",
      };
      await expect(memory.claimAgentAction(identity)).resolves.toEqual({
        status: "execute",
      });
      await expect(memory.claimAgentAction(identity)).resolves.toEqual({
        status: "in_progress",
      });
      await memory.completeAgentAction({
        requestDiscordMessageId: identity.requestDiscordMessageId,
        toolName: identity.toolName,
        argumentsHash: identity.argumentsHash,
        result: { messageId: "sent-1", channelId: "channel-1" },
      });
      await expect(memory.claimAgentAction(identity)).resolves.toEqual({
        status: "completed",
        result: { messageId: "sent-1", channelId: "channel-1" },
      });
    });
  },
);

function unitVector(index: number): number[] {
  return Array.from({ length: 1_024 }, (_, current) =>
    current === index ? 1 : 0,
  );
}
