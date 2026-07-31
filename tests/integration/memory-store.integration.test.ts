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
          agent_tool_calls,
          agent_runs,
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
  },
);
