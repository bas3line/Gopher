import type { DatabasePool } from "../db/pool.ts";
import type {
  ConversationSummary,
  RelevantMemory,
  StoredMessage,
  WebSource,
} from "../types.ts";
import type { AgentToolExecution } from "../agent/types.ts";
import type {
  AgentRunFinish,
  AgentRunStart,
  DiscordEventInput,
  DurableMemory,
  MemoryCandidate,
  MemoryContextPack,
  MemoryIngestionBatch,
  MemoryIngestionJob,
  MemoryKind,
  MemoryRecallInput,
  MemorySource,
} from "./types.ts";

interface RecordMessageInput {
  discordMessageId: string;
  guildId: string;
  channelId: string;
  userId: string;
  username: string;
  role: "user" | "assistant";
  content: string;
  attachments?: Array<{ url: string; name: string; contentType?: string }>;
  replyToDiscordMessageId?: string;
  createdAt?: Date;
}

export class MemoryStore {
  constructor(private readonly pool: DatabasePool) {}

  async recordMessage(input: RecordMessageInput): Promise<number | undefined> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<{ id: string }>(
        `
          INSERT INTO chat_messages (
            discord_message_id,
            guild_id,
            channel_id,
            user_id,
            username,
            role,
            content,
            attachments,
            reply_to_discord_message_id,
            created_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10)
          ON CONFLICT (discord_message_id) DO NOTHING
          RETURNING id
        `,
        [
          input.discordMessageId,
          input.guildId,
          input.channelId,
          input.userId,
          input.username,
          input.role,
          input.content,
          JSON.stringify(input.attachments ?? []),
          input.replyToDiscordMessageId ?? null,
          input.createdAt ?? new Date(),
        ],
      );
      const row = result.rows[0];
      if (!row) {
        await client.query("COMMIT");
        return undefined;
      }

      await client.query(
        `
          INSERT INTO discord_events (
            event_key,
            guild_id,
            channel_id,
            actor_user_id,
            event_type,
            payload,
            occurred_at
          )
          VALUES ($1, $2, $3, $4, 'message_create', $5::jsonb, $6)
          ON CONFLICT (event_key) DO NOTHING
        `,
        [
          `message:create:${input.discordMessageId}`,
          input.guildId,
          input.channelId,
          input.userId,
          JSON.stringify({
            discordMessageId: input.discordMessageId,
            role: input.role,
            username: input.username,
            attachmentCount: input.attachments?.length ?? 0,
            replyToDiscordMessageId: input.replyToDiscordMessageId ?? null,
          }),
          input.createdAt ?? new Date(),
        ],
      );
      await client.query(
        `
          INSERT INTO memory_ingestion_jobs (
            guild_id,
            channel_id,
            through_message_id
          )
          VALUES ($1, $2, $3)
          ON CONFLICT (guild_id, channel_id, through_message_id) DO UPDATE
          SET status = 'pending',
              attempts = 0,
              available_at = now(),
              locked_at = NULL,
              last_error_code = NULL,
              completed_at = NULL
        `,
        [input.guildId, input.channelId, row.id],
      );
      await client.query("COMMIT");
      return Number(row.id);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async recordMessageEdit(input: {
    discordMessageId: string;
    guildId: string;
    channelId: string;
    actorUserId: string;
    replacementContent: string;
    editedAt: Date;
  }): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const existing = await client.query<{
        id: string;
        content: string;
      }>(
        `
          SELECT id, content
          FROM chat_messages
          WHERE discord_message_id = $1
          FOR UPDATE
        `,
        [input.discordMessageId],
      );
      const row = existing.rows[0];
      if (!row || row.content === input.replacementContent) {
        await client.query("COMMIT");
        return false;
      }

      await client.query(
        `
          INSERT INTO chat_message_revisions (
            chat_message_id,
            previous_content,
            replacement_content,
            edited_at
          )
          VALUES ($1, $2, $3, $4)
        `,
        [row.id, row.content, input.replacementContent, input.editedAt],
      );
      await client.query(
        `
          UPDATE chat_messages
          SET content = $2,
              edited_at = $3
          WHERE id = $1
        `,
        [row.id, input.replacementContent, input.editedAt],
      );
      await client.query(
        `
          INSERT INTO discord_events (
            event_key,
            guild_id,
            channel_id,
            actor_user_id,
            event_type,
            payload,
            occurred_at
          )
          VALUES ($1, $2, $3, $4, 'message_edit', $5::jsonb, $6)
          ON CONFLICT (event_key) DO NOTHING
        `,
        [
          `message:edit:${input.discordMessageId}:${input.editedAt.toISOString()}`,
          input.guildId,
          input.channelId,
          input.actorUserId,
          JSON.stringify({ discordMessageId: input.discordMessageId }),
          input.editedAt,
        ],
      );
      await client.query(
        `
          INSERT INTO memory_channel_checkpoints (
            guild_id,
            channel_id,
            last_message_id
          )
          VALUES ($1, $2, GREATEST(0, $3::bigint - 1))
          ON CONFLICT (guild_id, channel_id) DO UPDATE
          SET last_message_id = LEAST(
                memory_channel_checkpoints.last_message_id,
                EXCLUDED.last_message_id
              ),
              updated_at = now()
        `,
        [input.guildId, input.channelId, row.id],
      );
      await client.query(
        `
          INSERT INTO memory_ingestion_jobs (
            guild_id,
            channel_id,
            through_message_id
          )
          VALUES ($1, $2, $3)
          ON CONFLICT (guild_id, channel_id, through_message_id) DO UPDATE
          SET status = 'pending',
              attempts = 0,
              available_at = now(),
              locked_at = NULL,
              last_error_code = NULL,
              completed_at = NULL
        `,
        [input.guildId, input.channelId, row.id],
      );
      await client.query("COMMIT");
      return true;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async recordMessageDeletion(input: {
    discordMessageId: string;
    guildId: string;
    channelId: string;
    actorUserId?: string;
    deletedAt: Date;
  }): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const updated = await client.query<{ id: string }>(
        `
          UPDATE chat_messages
          SET deleted_at = COALESCE(deleted_at, $2)
          WHERE discord_message_id = $1
            AND deleted_at IS NULL
          RETURNING id
        `,
        [input.discordMessageId, input.deletedAt],
      );
      if (!updated.rows[0]) {
        await client.query("COMMIT");
        return false;
      }
      await client.query(
        `
          INSERT INTO discord_events (
            event_key,
            guild_id,
            channel_id,
            actor_user_id,
            event_type,
            payload,
            occurred_at
          )
          VALUES ($1, $2, $3, $4, 'message_delete', $5::jsonb, $6)
          ON CONFLICT (event_key) DO NOTHING
        `,
        [
          `message:delete:${input.discordMessageId}`,
          input.guildId,
          input.channelId,
          input.actorUserId ?? null,
          JSON.stringify({ discordMessageId: input.discordMessageId }),
          input.deletedAt,
        ],
      );
      await client.query("COMMIT");
      return true;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async recordDiscordEvent(input: DiscordEventInput): Promise<boolean> {
    const result = await this.pool.query(
      `
        INSERT INTO discord_events (
          event_key,
          guild_id,
          channel_id,
          actor_user_id,
          event_type,
          payload,
          occurred_at
        )
        VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
        ON CONFLICT (event_key) DO NOTHING
      `,
      [
        input.eventKey,
        input.guildId,
        input.channelId,
        input.actorUserId ?? null,
        input.eventType,
        JSON.stringify(input.payload ?? {}),
        input.occurredAt,
      ],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async recent(guildId: string, channelId: string, count: number): Promise<StoredMessage[]> {
    const result = await this.pool.query<{
      id: string;
      discord_message_id: string;
      guild_id: string;
      channel_id: string;
      user_id: string;
      username: string;
      role: "user" | "assistant";
      content: string;
      created_at: Date;
    }>(
      `
        SELECT id, discord_message_id, guild_id, channel_id, user_id, username, role, content, created_at
        FROM chat_messages
        WHERE guild_id = $1 AND channel_id = $2
        ORDER BY id DESC
        LIMIT $3
      `,
      [guildId, channelId, count],
    );

    return result.rows.reverse().map((row) => ({
      id: Number(row.id),
      discordMessageId: row.discord_message_id,
      guildId: row.guild_id,
      channelId: row.channel_id,
      userId: row.user_id,
      username: row.username,
      role: row.role,
      content: row.content,
      createdAt: row.created_at,
    }));
  }

  async relevant(
    guildId: string,
    channelId: string,
    query: string,
    count: number,
  ): Promise<RelevantMemory[]> {
    if (query.trim().length < 3) return [];

    const result = await this.pool.query<{
      username: string;
      role: "user" | "assistant";
      content: string;
      created_at: Date;
      rank: number;
    }>(
      `
        WITH search AS (SELECT websearch_to_tsquery('english', $3) AS query)
        SELECT
          username,
          role,
          content,
          created_at,
          ts_rank_cd(search_vector, search.query)::float AS rank
        FROM chat_messages, search
        WHERE guild_id = $1
          AND channel_id = $2
          AND search_vector @@ search.query
        ORDER BY rank DESC, id DESC
        LIMIT $4
      `,
      [guildId, channelId, query, count],
    );

    return result.rows.map((row) => ({
      username: row.username,
      role: row.role,
      content: row.content,
      createdAt: row.created_at,
      rank: row.rank,
    }));
  }

  async summary(guildId: string, channelId: string): Promise<ConversationSummary | undefined> {
    const result = await this.pool.query<{
      summary: string;
      last_message_id: string;
      updated_at: Date;
    }>(
      `
        SELECT summary, last_message_id, updated_at
        FROM conversation_summaries
        WHERE guild_id = $1 AND channel_id = $2
      `,
      [guildId, channelId],
    );
    const row = result.rows[0];
    return row
      ? {
          summary: row.summary,
          lastMessageId: Number(row.last_message_id),
          updatedAt: row.updated_at,
        }
      : undefined;
  }

  async unsummarized(
    guildId: string,
    channelId: string,
    afterId: number,
    minimumCount: number,
  ): Promise<StoredMessage[]> {
    const result = await this.pool.query<{
      id: string;
      discord_message_id: string;
      guild_id: string;
      channel_id: string;
      user_id: string;
      username: string;
      role: "user" | "assistant";
      content: string;
      created_at: Date;
    }>(
      `
        SELECT id, discord_message_id, guild_id, channel_id, user_id, username, role, content, created_at
        FROM chat_messages
        WHERE guild_id = $1 AND channel_id = $2 AND id > $3
        ORDER BY id ASC
        LIMIT $4
      `,
      [guildId, channelId, afterId, minimumCount],
    );

    if (result.rows.length < minimumCount) return [];
    return result.rows.map((row) => ({
      id: Number(row.id),
      discordMessageId: row.discord_message_id,
      guildId: row.guild_id,
      channelId: row.channel_id,
      userId: row.user_id,
      username: row.username,
      role: row.role,
      content: row.content,
      createdAt: row.created_at,
    }));
  }

  async saveSummary(
    guildId: string,
    channelId: string,
    summary: string,
    lastMessageId: number,
  ): Promise<void> {
    await this.pool.query(
      `
        INSERT INTO conversation_summaries (guild_id, channel_id, summary, last_message_id)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (guild_id, channel_id) DO UPDATE
        SET summary = EXCLUDED.summary,
            last_message_id = EXCLUDED.last_message_id,
            updated_at = now()
        WHERE conversation_summaries.last_message_id < EXCLUDED.last_message_id
      `,
      [guildId, channelId, summary, lastMessageId],
    );
  }

  async saveWebSources(query: string, sources: WebSource[]): Promise<void> {
    if (sources.length === 0) return;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const source of sources) {
        await client.query(
          `
            INSERT INTO web_documents (query, url, title, description, content, published_at)
            VALUES ($1, $2, $3, $4, $5, $6)
            ON CONFLICT (url) DO UPDATE
            SET query = EXCLUDED.query,
                title = EXCLUDED.title,
                description = EXCLUDED.description,
                content = EXCLUDED.content,
                published_at = EXCLUDED.published_at,
                fetched_at = now()
          `,
          [
            query,
            source.url,
            source.title,
            source.description,
            source.content,
            source.publishedAt ?? null,
          ],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async recall(input: MemoryRecallInput): Promise<DurableMemory[]> {
    const query = input.query.trim().slice(0, 2_000);
    const result = await this.pool.query<MemoryRow>(
      `
        WITH search AS (
          SELECT CASE
            WHEN char_length(trim($4)) >= 2
              THEN websearch_to_tsquery('english', $4)
            ELSE NULL::tsquery
          END AS query
        )
        SELECT
          memory_items.*,
          (
            COALESCE(ts_rank_cd(memory_items.search_vector, search.query), 0) * 4.0
            + GREATEST(
                similarity(memory_items.content, $4),
                similarity(replace(memory_items.memory_key, '.', ' '), $4)
              ) * 1.5
            + (memory_items.importance::float8 / 10.0) * 1.2
            + memory_items.confidence::float8 * 0.8
            + CASE WHEN memory_items.pinned THEN 2.0 ELSE 0.0 END
            + (
                1.0 / (
                  1.0
                  + EXTRACT(EPOCH FROM (now() - memory_items.updated_at))
                    / 86400.0
                    / 30.0
                )
              ) * 0.6
            + ln(memory_items.access_count + 1.0) * 0.1
          )::float8 AS score
        FROM memory_items
        CROSS JOIN search
        WHERE memory_items.guild_id = $1
          AND memory_items.status = 'active'
          AND (
            memory_items.expires_at IS NULL
            OR memory_items.expires_at > now()
          )
          AND (
            ($5::boolean AND memory_items.scope = 'channel' AND memory_items.scope_id = $2)
            OR ($6::boolean AND memory_items.scope = 'user' AND memory_items.scope_id = $3)
            OR ($7::boolean AND memory_items.scope = 'guild' AND memory_items.scope_id = $1)
          )
          AND ($8::text[] IS NULL OR memory_items.kind = ANY($8::text[]))
          AND (
            search.query IS NULL
            OR memory_items.search_vector @@ search.query
            OR similarity(memory_items.content, $4) >= 0.08
            OR similarity(replace(memory_items.memory_key, '.', ' '), $4) >= 0.12
          )
        ORDER BY memory_items.pinned DESC, score DESC, memory_items.updated_at DESC
        LIMIT $9
      `,
      [
        input.guildId,
        input.channelId,
        input.userId,
        query,
        input.includeChannel ?? true,
        input.includeUser ?? true,
        input.includeGuild ?? true,
        input.kinds?.length ? input.kinds : null,
        input.limit,
      ],
    );
    const memories = result.rows.map(mapMemoryRow);
    if (memories.length > 0) {
      await this.pool.query(
        `
          UPDATE memory_items
          SET last_accessed_at = now(),
              access_count = access_count + 1
          WHERE id = ANY($1::bigint[])
        `,
        [memories.map((memory) => memory.id)],
      );
    }
    return memories;
  }

  async contextPack(input: MemoryRecallInput): Promise<MemoryContextPack> {
    const [durable, commitments] = await Promise.all([
      this.recall(input),
      this.recall({
        ...input,
        query: input.query || "active decisions commitments projects preferences",
        limit: Math.min(8, input.limit),
        kinds: ["commitment", "decision", "project"],
      }),
    ]);
    const seen = new Set(durable.map((memory) => memory.id));
    return {
      durable,
      commitments: commitments.filter((memory) => !seen.has(memory.id)),
    };
  }

  async upsertMemories(input: {
    guildId: string;
    channelId: string;
    candidates: MemoryCandidate[];
    source: MemorySource;
  }): Promise<DurableMemory[]> {
    if (input.candidates.length === 0) return [];
    const client = await this.pool.connect();
    const savedIds: number[] = [];
    try {
      await client.query("BEGIN");
      for (const candidate of input.candidates.slice(0, 24)) {
        const key = normalizeMemoryKey(candidate.key);
        const content = candidate.content.trim().slice(0, 4_000);
        const scopeId =
          candidate.scope === "user"
            ? candidate.subjectUserId
            : candidate.scope === "channel"
              ? input.channelId
              : input.guildId;
        if (!scopeId) continue;
        const expiresAt =
          candidate.ttlDays !== undefined
            ? new Date(Date.now() + candidate.ttlDays * 86_400_000)
            : null;
        const existing = await client.query<MemoryRow>(
          `
            SELECT *, 0::float8 AS score
            FROM memory_items
            WHERE guild_id = $1
              AND scope = $2
              AND scope_id = $3
              AND kind = $4
              AND memory_key = $5
              AND status = 'active'
            FOR UPDATE
          `,
          [input.guildId, candidate.scope, scopeId, candidate.kind, key],
        );
        const row = existing.rows[0];
        if (!row) {
          const inserted = await client.query<{ id: string }>(
            `
              INSERT INTO memory_items (
                guild_id,
                scope,
                scope_id,
                subject_user_id,
                kind,
                memory_key,
                content,
                importance,
                confidence,
                source,
                evidence_message_ids,
                metadata,
                expires_at
              )
              VALUES (
                $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::text[], $12::jsonb, $13
              )
              RETURNING id
            `,
            [
              input.guildId,
              candidate.scope,
              scopeId,
              candidate.subjectUserId ?? null,
              candidate.kind,
              key,
              content,
              candidate.importance,
              candidate.confidence,
              input.source,
              candidate.evidenceMessageIds,
              JSON.stringify({ reason: candidate.reason }),
              expiresAt,
            ],
          );
          const insertedRow = inserted.rows[0];
          if (insertedRow) savedIds.push(Number(insertedRow.id));
          continue;
        }

        if (normalizeMemoryContent(row.content) === normalizeMemoryContent(content)) {
          await client.query(
            `
              UPDATE memory_items
              SET importance = GREATEST(importance, $2),
                  confidence = LEAST(0.99, GREATEST(confidence, $3) + 0.02),
                  source = CASE
                    WHEN $4 = 'explicit' THEN 'explicit'
                    ELSE source
                  END,
                  evidence_message_ids = ARRAY(
                    SELECT DISTINCT value
                    FROM unnest(evidence_message_ids || $5::text[]) AS value
                    LIMIT 32
                  ),
                  metadata = metadata || $6::jsonb,
                  expires_at = CASE
                    WHEN $7::timestamptz IS NULL THEN expires_at
                    WHEN expires_at IS NULL THEN $7::timestamptz
                    ELSE GREATEST(expires_at, $7::timestamptz)
                  END,
                  last_confirmed_at = now(),
                  updated_at = now()
              WHERE id = $1
            `,
            [
              row.id,
              candidate.importance,
              candidate.confidence,
              input.source,
              candidate.evidenceMessageIds,
              JSON.stringify({ reason: candidate.reason }),
              expiresAt,
            ],
          );
          savedIds.push(Number(row.id));
          continue;
        }

        await client.query(
          `
            INSERT INTO memory_item_revisions (
              memory_item_id,
              version,
              previous_content,
              previous_confidence,
              previous_importance,
              previous_status,
              reason,
              evidence_message_ids
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8::text[])
          `,
          [
            row.id,
            row.version,
            row.content,
            row.confidence,
            row.importance,
            row.status,
            candidate.reason,
            candidate.evidenceMessageIds,
          ],
        );
        await client.query(
          `
            UPDATE memory_items
            SET content = $2,
                importance = $3,
                confidence = $4,
                source = $5,
                evidence_message_ids = ARRAY(
                  SELECT DISTINCT value
                  FROM unnest(evidence_message_ids || $6::text[]) AS value
                  LIMIT 32
                ),
                metadata = metadata || $7::jsonb,
                version = version + 1,
                expires_at = $8,
                last_confirmed_at = now(),
                updated_at = now()
            WHERE id = $1
          `,
          [
            row.id,
            content,
            candidate.importance,
            candidate.confidence,
            input.source,
            candidate.evidenceMessageIds,
            JSON.stringify({ reason: candidate.reason }),
            expiresAt,
          ],
        );
        savedIds.push(Number(row.id));
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    if (savedIds.length === 0) return [];
    const saved = await this.pool.query<MemoryRow>(
      `
        SELECT *, 0::float8 AS score
        FROM memory_items
        WHERE id = ANY($1::bigint[])
        ORDER BY id
      `,
      [savedIds],
    );
    return saved.rows.map(mapMemoryRow);
  }

  async forgetMemory(input: {
    id: number;
    guildId: string;
    requesterUserId: string;
    allowGuildScope: boolean;
    reason: string;
  }): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const existing = await client.query<MemoryRow>(
        `
          SELECT *, 0::float8 AS score
          FROM memory_items
          WHERE id = $1
            AND guild_id = $2
            AND status = 'active'
            AND (
              (scope = 'user' AND scope_id = $3)
              OR $4::boolean
            )
          FOR UPDATE
        `,
        [
          input.id,
          input.guildId,
          input.requesterUserId,
          input.allowGuildScope,
        ],
      );
      const row = existing.rows[0];
      if (!row) {
        await client.query("COMMIT");
        return false;
      }
      await client.query(
        `
          INSERT INTO memory_item_revisions (
            memory_item_id,
            version,
            previous_content,
            previous_confidence,
            previous_importance,
            previous_status,
            reason,
            evidence_message_ids
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, ARRAY[]::text[])
        `,
        [
          row.id,
          row.version,
          row.content,
          row.confidence,
          row.importance,
          row.status,
          input.reason.slice(0, 500),
        ],
      );
      await client.query(
        `
          UPDATE memory_items
          SET status = 'forgotten',
              version = version + 1,
              updated_at = now()
          WHERE id = $1
        `,
        [row.id],
      );
      await client.query("COMMIT");
      return true;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async claimMemoryIngestionJob(): Promise<MemoryIngestionJob | undefined> {
    const result = await this.pool.query<{
      id: string;
      guild_id: string;
      channel_id: string;
      through_message_id: string;
      attempts: number;
    }>(
      `
        WITH seed AS (
          SELECT guild_id, channel_id
          FROM memory_ingestion_jobs
          WHERE (
              status = 'pending'
              AND available_at <= now()
            )
            OR (
              status = 'processing'
              AND locked_at < now() - interval '5 minutes'
            )
          ORDER BY available_at, id
          LIMIT 1
        ),
        next_job AS (
          SELECT jobs.id
          FROM memory_ingestion_jobs AS jobs
          INNER JOIN seed
            ON seed.guild_id = jobs.guild_id
            AND seed.channel_id = jobs.channel_id
          WHERE (
              jobs.status = 'pending'
              AND jobs.available_at <= now()
            )
            OR (
              jobs.status = 'processing'
              AND jobs.locked_at < now() - interval '5 minutes'
            )
          ORDER BY jobs.through_message_id DESC, jobs.id DESC
          FOR UPDATE OF jobs SKIP LOCKED
          LIMIT 1
        )
        UPDATE memory_ingestion_jobs AS jobs
        SET status = 'processing',
            attempts = attempts + 1,
            locked_at = now()
        FROM next_job
        WHERE jobs.id = next_job.id
        RETURNING
          jobs.id,
          jobs.guild_id,
          jobs.channel_id,
          jobs.through_message_id,
          jobs.attempts
      `,
    );
    const row = result.rows[0];
    return row
      ? {
          id: Number(row.id),
          guildId: row.guild_id,
          channelId: row.channel_id,
          throughMessageId: Number(row.through_message_id),
          attempts: row.attempts,
        }
      : undefined;
  }

  async memoryIngestionBatch(
    job: MemoryIngestionJob,
    maximumMessages: number,
  ): Promise<MemoryIngestionBatch> {
    const checkpointResult = await this.pool.query<{
      last_message_id: string;
    }>(
      `
        SELECT last_message_id
        FROM memory_channel_checkpoints
        WHERE guild_id = $1 AND channel_id = $2
      `,
      [job.guildId, job.channelId],
    );
    const checkpoint = Number(
      checkpointResult.rows[0]?.last_message_id ?? 0,
    );
    const messagesResult = await this.pool.query<StoredMessageRow>(
      `
        SELECT
          id,
          discord_message_id,
          guild_id,
          channel_id,
          user_id,
          username,
          role,
          content,
          created_at
        FROM chat_messages
        WHERE guild_id = $1
          AND channel_id = $2
          AND id > $3
          AND id <= $4
        ORDER BY id
        LIMIT $5
      `,
      [
        job.guildId,
        job.channelId,
        checkpoint,
        job.throughMessageId,
        maximumMessages,
      ],
    );
    const messages = messagesResult.rows.map(mapStoredMessageRow);
    const knownUserIds = [
      ...new Set(
        messages
          .filter((message) => message.role === "user")
          .map((message) => message.userId),
      ),
    ];
    const existingResult = await this.pool.query<MemoryRow>(
      `
        SELECT *, 0::float8 AS score
        FROM memory_items
        WHERE guild_id = $1
          AND status = 'active'
          AND (
            (scope = 'channel' AND scope_id = $2)
            OR (scope = 'guild' AND scope_id = $1)
            OR (
              scope = 'user'
              AND scope_id = ANY($3::text[])
            )
          )
        ORDER BY pinned DESC, importance DESC, updated_at DESC
        LIMIT 120
      `,
      [job.guildId, job.channelId, knownUserIds],
    );
    const lastProcessed = messages.at(-1)?.id ?? checkpoint;
    return {
      job,
      messages,
      existing: existingResult.rows.map(mapMemoryRow),
      knownUserIds,
      checkpoint,
      reachedTarget: lastProcessed >= job.throughMessageId,
    };
  }

  async finishMemoryIngestion(input: {
    job: MemoryIngestionJob;
    lastProcessedMessageId: number;
    reachedTarget: boolean;
  }): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `
          INSERT INTO memory_channel_checkpoints (
            guild_id,
            channel_id,
            last_message_id
          )
          VALUES ($1, $2, $3)
          ON CONFLICT (guild_id, channel_id) DO UPDATE
          SET last_message_id = GREATEST(
                memory_channel_checkpoints.last_message_id,
                EXCLUDED.last_message_id
              ),
              updated_at = now()
        `,
        [
          input.job.guildId,
          input.job.channelId,
          input.lastProcessedMessageId,
        ],
      );
      await client.query(
        `
          UPDATE memory_ingestion_jobs
          SET status = 'completed',
              locked_at = NULL,
              completed_at = now(),
              last_error_code = NULL
          WHERE guild_id = $1
            AND channel_id = $2
            AND through_message_id <= $3
            AND status IN ('pending', 'processing')
        `,
        [
          input.job.guildId,
          input.job.channelId,
          input.lastProcessedMessageId,
        ],
      );
      await client.query(
        `
          UPDATE memory_ingestion_jobs
          SET status = CASE WHEN $2::boolean THEN 'completed' ELSE 'pending' END,
              available_at = now(),
              locked_at = NULL,
              completed_at = CASE WHEN $2::boolean THEN now() ELSE NULL END,
              last_error_code = NULL
          WHERE id = $1
        `,
        [input.job.id, input.reachedTarget],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async failMemoryIngestionJob(
    job: MemoryIngestionJob,
    errorCode: string,
  ): Promise<void> {
    await this.pool.query(
      `
        UPDATE memory_ingestion_jobs
        SET status = CASE WHEN attempts >= 5 THEN 'failed' ELSE 'pending' END,
            available_at = now()
              + LEAST(300, power(2, attempts)::integer) * interval '1 second',
            locked_at = NULL,
            last_error_code = $2,
            completed_at = CASE WHEN attempts >= 5 THEN now() ELSE NULL END
        WHERE id = $1
      `,
      [job.id, errorCode.replace(/[^a-z0-9_.:-]/gi, "_").slice(0, 120)],
    );
  }

  async startAgentRun(input: AgentRunStart): Promise<void> {
    await this.pool.query(
      `
        INSERT INTO agent_runs (
          id,
          guild_id,
          channel_id,
          user_id,
          discord_message_id,
          model,
          status
        )
        VALUES ($1, $2, $3, $4, $5, $6, 'running')
        ON CONFLICT (id) DO NOTHING
      `,
      [
        input.id,
        input.guildId,
        input.channelId,
        input.userId,
        input.discordMessageId,
        input.model,
      ],
    );
  }

  async finishAgentRun(input: AgentRunFinish): Promise<void> {
    await this.pool.query(
      `
        UPDATE agent_runs
        SET status = $2,
            iterations = $3,
            tool_calls = $4,
            prompt_tokens = $5,
            completion_tokens = $6,
            error_code = $7,
            completed_at = now()
        WHERE id = $1
      `,
      [
        input.id,
        input.status,
        input.iterations,
        input.toolCalls,
        input.promptTokens ?? null,
        input.completionTokens ?? null,
        input.errorCode ?? null,
      ],
    );
  }

  async recordAgentToolExecution(
    runId: string,
    execution: AgentToolExecution,
  ): Promise<void> {
    await this.pool.query(
      `
        INSERT INTO agent_tool_calls (
          run_id,
          call_id,
          iteration,
          tool_name,
          effect,
          success,
          cached,
          duration_ms,
          error_code,
          output_preview
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        ON CONFLICT (run_id, call_id) DO UPDATE
        SET success = EXCLUDED.success,
            cached = EXCLUDED.cached,
            duration_ms = EXCLUDED.duration_ms,
            error_code = EXCLUDED.error_code,
            output_preview = EXCLUDED.output_preview
      `,
      [
        runId,
        execution.callId,
        execution.iteration,
        execution.name,
        execution.effect,
        execution.success,
        execution.cached,
        execution.durationMs,
        execution.errorCode ?? null,
        execution.output.slice(0, 2_000),
      ],
    );
  }

  async memoryOverview(input: {
    guildId: string;
    channelId: string;
    userId: string;
  }): Promise<{
    total: number;
    user: number;
    channel: number;
    guild: number;
    pendingIngestion: number;
  }> {
    const result = await this.pool.query<{
      total: string;
      user_count: string;
      channel_count: string;
      guild_count: string;
      pending_ingestion: string;
    }>(
      `
        SELECT
          COUNT(*) FILTER (
            WHERE status = 'active'
              AND (
                (scope = 'user' AND scope_id = $3)
                OR (scope = 'channel' AND scope_id = $2)
                OR (scope = 'guild' AND scope_id = $1)
              )
          ) AS total,
          COUNT(*) FILTER (
            WHERE status = 'active' AND scope = 'user' AND scope_id = $3
          ) AS user_count,
          COUNT(*) FILTER (
            WHERE status = 'active' AND scope = 'channel' AND scope_id = $2
          ) AS channel_count,
          COUNT(*) FILTER (
            WHERE status = 'active' AND scope = 'guild' AND scope_id = $1
          ) AS guild_count,
          (
            SELECT COUNT(*)
            FROM memory_ingestion_jobs
            WHERE guild_id = $1
              AND channel_id = $2
              AND status IN ('pending', 'processing')
          ) AS pending_ingestion
        FROM memory_items
        WHERE guild_id = $1
      `,
      [input.guildId, input.channelId, input.userId],
    );
    const row = result.rows[0];
    return {
      total: Number(row?.total ?? 0),
      user: Number(row?.user_count ?? 0),
      channel: Number(row?.channel_count ?? 0),
      guild: Number(row?.guild_count ?? 0),
      pendingIngestion: Number(row?.pending_ingestion ?? 0),
    };
  }

  async recordAIEvent(input: {
    guildId: string;
    channelId: string;
    userId: string;
    model: string;
    kind:
      | "chat"
      | "vision"
      | "summary"
      | "voice_stt"
      | "voice_chat"
      | "agent"
      | "memory_extract";
    success: boolean;
    latencyMs: number;
    promptTokens?: number;
    completionTokens?: number;
  }): Promise<void> {
    await this.pool.query(
      `
        INSERT INTO ai_events (
          guild_id, channel_id, user_id, model, kind, success, latency_ms,
          prompt_tokens, completion_tokens
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      `,
      [
        input.guildId,
        input.channelId,
        input.userId,
        input.model,
        input.kind,
        input.success,
        input.latencyMs,
        input.promptTokens ?? null,
        input.completionTokens ?? null,
      ],
    );
  }
}

interface StoredMessageRow {
  id: string;
  discord_message_id: string;
  guild_id: string;
  channel_id: string;
  user_id: string;
  username: string;
  role: "user" | "assistant";
  content: string;
  created_at: Date;
}

interface MemoryRow {
  id: string;
  guild_id: string;
  scope: DurableMemory["scope"];
  scope_id: string;
  subject_user_id: string | null;
  kind: DurableMemory["kind"];
  memory_key: string;
  content: string;
  importance: number;
  confidence: number;
  source: DurableMemory["source"];
  evidence_message_ids: string[];
  status: "active" | "superseded" | "forgotten";
  pinned: boolean;
  version: number;
  valid_from: Date;
  expires_at: Date | null;
  last_confirmed_at: Date;
  last_accessed_at: Date | null;
  access_count: number;
  created_at: Date;
  updated_at: Date;
  score: number;
}

function mapStoredMessageRow(row: StoredMessageRow): StoredMessage {
  return {
    id: Number(row.id),
    discordMessageId: row.discord_message_id,
    guildId: row.guild_id,
    channelId: row.channel_id,
    userId: row.user_id,
    username: row.username,
    role: row.role,
    content: row.content,
    createdAt: row.created_at,
  };
}

function mapMemoryRow(row: MemoryRow): DurableMemory {
  return {
    id: Number(row.id),
    guildId: row.guild_id,
    scope: row.scope,
    scopeId: row.scope_id,
    ...(row.subject_user_id
      ? { subjectUserId: row.subject_user_id }
      : {}),
    kind: row.kind,
    key: row.memory_key,
    content: row.content,
    importance: Number(row.importance),
    confidence: Number(row.confidence),
    source: row.source,
    evidenceMessageIds: row.evidence_message_ids,
    pinned: row.pinned,
    version: row.version,
    validFrom: row.valid_from,
    ...(row.expires_at ? { expiresAt: row.expires_at } : {}),
    lastConfirmedAt: row.last_confirmed_at,
    ...(row.last_accessed_at
      ? { lastAccessedAt: row.last_accessed_at }
      : {}),
    accessCount: row.access_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    score: Number(row.score),
  };
}

export function normalizeMemoryKey(input: string): string {
  const key = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, ".")
    .replace(/^[^a-z0-9]+/, "")
    .replace(/[._:-]+$/, "")
    .replace(/[._:-]{2,}/g, ".")
    .slice(0, 120);
  if (!/^[a-z0-9][a-z0-9._:-]{1,119}$/.test(key)) {
    throw new Error("memory key must contain at least two safe characters");
  }
  return key;
}

function normalizeMemoryContent(input: string): string {
  return input.trim().replace(/\s+/g, " ").toLocaleLowerCase("en");
}
