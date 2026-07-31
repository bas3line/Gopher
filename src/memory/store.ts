import type { DatabasePool } from "../db/pool.ts";
import type { EmbeddingProvider } from "../ai/embeddings.ts";
import type { Logger } from "../logger.ts";
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
  MemoryEmbeddingJob,
  MemoryIdentity,
  MemoryIngestionBatch,
  MemoryIngestionJob,
  MemoryKind,
  MemoryRelation,
  MemoryRelationCandidate,
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
  constructor(
    private readonly pool: DatabasePool,
    private readonly options: {
      embedding?: EmbeddingProvider;
      logger?: Logger;
    } = {},
  ) {}

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
            AND deleted_at IS NULL
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
          SELECT
            id,
            version,
            content,
            confidence,
            importance,
            status,
            'A supporting Discord message was edited; the old interpretation was superseded.',
            ARRAY[$2]::text[]
          FROM memory_items
          WHERE guild_id = $1
            AND status = 'active'
            AND $2 = ANY(evidence_message_ids)
          ON CONFLICT (memory_item_id, version) DO NOTHING
        `,
        [input.guildId, input.discordMessageId],
      );
      await client.query(
        `
          UPDATE memory_items
          SET status = 'superseded',
              evidence_message_ids = array_remove(
                evidence_message_ids,
                $2
              ),
              version = version + 1,
              updated_at = now()
          WHERE guild_id = $1
            AND status = 'active'
            AND $2 = ANY(evidence_message_ids)
        `,
        [input.guildId, input.discordMessageId],
      );
      await client.query(
        `
          INSERT INTO memory_link_revisions (
            from_memory_id,
            to_memory_id,
            relation,
            previous_confidence,
            previous_evidence_message_ids,
            reason
          )
          SELECT
            from_memory_id,
            to_memory_id,
            relation,
            confidence,
            evidence_message_ids,
            'A supporting Discord message was edited; graph provenance was revoked.'
          FROM memory_links
          WHERE $1 = ANY(evidence_message_ids)
        `,
        [input.discordMessageId],
      );
      await client.query(
        `
          DELETE FROM memory_links
          WHERE $1 = ANY(evidence_message_ids)
            AND cardinality(evidence_message_ids) = 1
        `,
        [input.discordMessageId],
      );
      await client.query(
        `
          UPDATE memory_links
          SET evidence_message_ids = array_remove(
                evidence_message_ids,
                $1
              ),
              confidence = GREATEST(0, confidence - 0.1),
              updated_at = now()
          WHERE $1 = ANY(evidence_message_ids)
        `,
        [input.discordMessageId],
      );
      await client.query(
        `
          DELETE FROM memory_embedding_jobs AS jobs
          USING memory_items AS items
          WHERE items.id = jobs.memory_item_id
            AND items.guild_id = $1
            AND items.status <> 'active'
        `,
        [input.guildId],
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
      const deletedMessageId = Number(updated.rows[0].id);
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
          SELECT
            id,
            version,
            content,
            confidence,
            importance,
            status,
            'A supporting Discord message was deleted; provenance was revoked.',
            ARRAY[$2]::text[]
          FROM memory_items
          WHERE guild_id = $1
            AND status = 'active'
            AND $2 = ANY(evidence_message_ids)
          ON CONFLICT (memory_item_id, version) DO NOTHING
        `,
        [input.guildId, input.discordMessageId],
      );
      await client.query(
        `
          UPDATE memory_items
          SET evidence_message_ids = array_remove(
                evidence_message_ids,
                $2
              ),
              status = CASE
                WHEN cardinality(
                  array_remove(evidence_message_ids, $2)
                ) = 0
                  THEN 'forgotten'
                ELSE status
              END,
              confidence = CASE
                WHEN cardinality(
                  array_remove(evidence_message_ids, $2)
                ) = 0
                  THEN confidence
                ELSE GREATEST(0, confidence - 0.1)
              END,
              version = version + 1,
              updated_at = now()
          WHERE guild_id = $1
            AND status = 'active'
            AND $2 = ANY(evidence_message_ids)
        `,
        [input.guildId, input.discordMessageId],
      );
      await client.query(
        `
          INSERT INTO memory_link_revisions (
            from_memory_id,
            to_memory_id,
            relation,
            previous_confidence,
            previous_evidence_message_ids,
            reason
          )
          SELECT
            from_memory_id,
            to_memory_id,
            relation,
            confidence,
            evidence_message_ids,
            'A supporting Discord message was deleted; graph provenance was revoked.'
          FROM memory_links
          WHERE $1 = ANY(evidence_message_ids)
        `,
        [input.discordMessageId],
      );
      await client.query(
        `
          DELETE FROM memory_links
          WHERE $1 = ANY(evidence_message_ids)
            AND cardinality(evidence_message_ids) = 1
        `,
        [input.discordMessageId],
      );
      await client.query(
        `
          UPDATE memory_links
          SET evidence_message_ids = array_remove(
                evidence_message_ids,
                $1
              ),
              confidence = GREATEST(0, confidence - 0.1),
              updated_at = now()
          WHERE $1 = ANY(evidence_message_ids)
        `,
        [input.discordMessageId],
      );
      await client.query(
        `
          DELETE FROM memory_embedding_jobs AS jobs
          USING memory_items AS items
          WHERE items.id = jobs.memory_item_id
            AND items.guild_id = $1
            AND items.status <> 'active'
        `,
        [input.guildId],
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
        [input.guildId, input.channelId, deletedMessageId],
      );
      await client.query(
        `
          INSERT INTO memory_ingestion_jobs (
            guild_id,
            channel_id,
            through_message_id
          )
          SELECT $1, $2, COALESCE(MAX(id), $3::bigint)
          FROM chat_messages
          WHERE guild_id = $1
            AND channel_id = $2
          ON CONFLICT (guild_id, channel_id, through_message_id) DO UPDATE
          SET status = 'pending',
              attempts = 0,
              available_at = now(),
              locked_at = NULL,
              last_error_code = NULL,
              completed_at = NULL
        `,
        [input.guildId, input.channelId, deletedMessageId],
      );
      await client.query(
        `
          DELETE FROM conversation_summaries
          WHERE guild_id = $1 AND channel_id = $2
        `,
        [input.guildId, input.channelId],
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
        WHERE guild_id = $1
          AND channel_id = $2
          AND deleted_at IS NULL
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
          AND deleted_at IS NULL
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
        WHERE guild_id = $1
          AND channel_id = $2
          AND id > $3
          AND deleted_at IS NULL
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
    const semantic = await this.embedRecallQuery(input, query);
    const candidateLimit = Math.max(40, Math.min(160, input.limit * 8));
    const result = await this.pool.query<MemoryRow>(
      `
        WITH settings AS MATERIALIZED (
          SELECT
            set_config('hnsw.ef_search', '100', true),
            set_config('hnsw.iterative_scan', 'strict_order', true)
        ),
        search AS (
          SELECT CASE
            WHEN char_length(trim($4)) >= 2
              THEN websearch_to_tsquery('english', $4)
            ELSE NULL::tsquery
          END AS query
        ),
        lexical AS (
          SELECT
            memory_items.id,
            (
              COALESCE(
                ts_rank_cd(memory_items.search_vector, search.query),
                0
              ) * 4.0
              + GREATEST(
                  similarity(memory_items.content, $4),
                  similarity(
                    replace(memory_items.memory_key, '.', ' '),
                    $4
                  )
                ) * 1.5
            )::float8 AS lexical_score
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
              OR similarity(
                replace(memory_items.memory_key, '.', ' '),
                $4
              ) >= 0.12
            )
          ORDER BY lexical_score DESC, memory_items.updated_at DESC
          LIMIT $12
        ),
        semantic AS (
          SELECT
            memory_items.id,
            (
              1.0 - (memory_items.embedding <=> $10::vector)
            )::float8 AS semantic_similarity
          FROM memory_items
          CROSS JOIN settings
          WHERE ($10::vector) IS NOT NULL
            AND memory_items.embedding IS NOT NULL
            AND memory_items.embedding_model = $11
            AND memory_items.guild_id = $1
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
          ORDER BY memory_items.embedding <=> $10::vector
          LIMIT $12
        ),
        candidates AS (
          SELECT id FROM lexical
          UNION
          SELECT id FROM semantic
        )
        SELECT
          memory_items.*,
          (
            COALESCE(lexical.lexical_score, 0)
            + COALESCE(semantic.semantic_similarity, 0) * 3.5
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
          )::float8 AS score,
          semantic.semantic_similarity
        FROM memory_items
        INNER JOIN candidates ON candidates.id = memory_items.id
        LEFT JOIN lexical ON lexical.id = memory_items.id
        LEFT JOIN semantic ON semantic.id = memory_items.id
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
        semantic?.vector ?? null,
        semantic?.model ?? null,
        candidateLimit,
      ],
    );
    const primary = result.rows.map(mapMemoryRow);
    const graph = await this.expandRecallGraph(input, primary);
    const byId = new Map<number, DurableMemory>();
    for (const memory of [...primary, ...graph]) {
      const existing = byId.get(memory.id);
      if (!existing || memory.score > existing.score) {
        byId.set(memory.id, memory);
      }
    }
    const memories = [...byId.values()]
      .sort(
        (left, right) =>
          Number(right.pinned) - Number(left.pinned) ||
          right.score - left.score ||
          right.updatedAt.getTime() - left.updatedAt.getTime(),
      )
      .slice(0, input.limit);
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

  private async expandRecallGraph(
    input: MemoryRecallInput,
    seeds: DurableMemory[],
  ): Promise<DurableMemory[]> {
    if (seeds.length === 0 || input.limit <= 1) return [];
    const seedScores = new Map(seeds.map((memory) => [memory.id, memory.score]));
    const result = await this.pool.query<MemoryRow>(
      `
        WITH edges AS (
          SELECT
            CASE
              WHEN links.from_memory_id = ANY($4::bigint[])
                THEN links.to_memory_id
              ELSE links.from_memory_id
            END AS neighbor_id,
            CASE
              WHEN links.from_memory_id = ANY($4::bigint[])
                THEN links.from_memory_id
              ELSE links.to_memory_id
            END AS seed_id,
            links.relation,
            links.confidence,
            CASE
              WHEN links.from_memory_id = ANY($4::bigint[])
                THEN 'outbound'
              ELSE 'inbound'
            END AS direction,
            links.updated_at
          FROM memory_links AS links
          WHERE links.from_memory_id = ANY($4::bigint[])
             OR links.to_memory_id = ANY($4::bigint[])
        ),
        strongest_edges AS (
          SELECT DISTINCT ON (neighbor_id)
            neighbor_id,
            seed_id,
            relation,
            confidence,
            direction
          FROM edges
          WHERE neighbor_id <> ALL($4::bigint[])
          ORDER BY neighbor_id, confidence DESC, updated_at DESC
        )
        SELECT
          memory_items.*,
          (
            strongest_edges.confidence::float8 * 1.4
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
          )::float8 AS score,
          NULL::float8 AS semantic_similarity,
          strongest_edges.seed_id AS linked_from_memory_id,
          strongest_edges.relation AS link_relation,
          strongest_edges.confidence AS link_confidence,
          strongest_edges.direction AS link_direction
        FROM strongest_edges
        INNER JOIN memory_items
          ON memory_items.id = strongest_edges.neighbor_id
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
        ORDER BY
          memory_items.pinned DESC,
          score DESC,
          memory_items.updated_at DESC
        LIMIT $9
      `,
      [
        input.guildId,
        input.channelId,
        input.userId,
        seeds.map((memory) => memory.id),
        input.includeChannel ?? true,
        input.includeUser ?? true,
        input.includeGuild ?? true,
        input.kinds?.length ? input.kinds : null,
        Math.max(8, Math.min(64, input.limit * 4)),
      ],
    );
    return result.rows.map((row) => {
      const memory = mapMemoryRow(row);
      const seedScore = memory.linkedFromMemoryId
        ? seedScores.get(memory.linkedFromMemoryId)
        : undefined;
      return {
        ...memory,
        score:
          seedScore === undefined
            ? memory.score
            : Math.max(
                memory.score,
                seedScore * 0.72 + (memory.linkConfidence ?? 0) * 1.2,
              ),
      };
    });
  }

  private async embedRecallQuery(
    input: MemoryRecallInput,
    query: string,
  ): Promise<{ vector: string; model: string } | undefined> {
    const embedding = this.options.embedding;
    if (!embedding || query.length < 2) return undefined;
    const startedAt = performance.now();
    try {
      const result = await embedding.embed([query]);
      const vector = result.vectors[0];
      if (!vector) return undefined;
      await this.recordAIEvent({
        guildId: input.guildId,
        channelId: input.channelId,
        userId: input.userId,
        model: embedding.model,
        kind: "memory_embed",
        success: true,
        latencyMs: Math.round(performance.now() - startedAt),
        ...(result.promptTokens !== undefined
          ? { promptTokens: result.promptTokens }
          : {}),
      }).catch(() => undefined);
      return { vector: vectorSql(vector), model: embedding.model };
    } catch (error) {
      this.options.logger?.warn(
        {
          err:
            error instanceof Error
              ? { name: error.name, message: error.message }
              : "unknown embedding error",
        },
        "semantic memory query embedding failed; using lexical recall",
      );
      await this.recordAIEvent({
        guildId: input.guildId,
        channelId: input.channelId,
        userId: input.userId,
        model: embedding.model,
        kind: "memory_embed",
        success: false,
        latencyMs: Math.round(performance.now() - startedAt),
      }).catch(() => undefined);
      return undefined;
    }
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
      if (savedIds.length > 0) {
        await client.query(
          `
            INSERT INTO memory_embedding_jobs (
              memory_item_id,
              guild_id,
              channel_id,
              memory_version
            )
            SELECT id, guild_id, $2, version
            FROM memory_items
            WHERE id = ANY($1::bigint[])
              AND status = 'active'
            ON CONFLICT (memory_item_id) DO UPDATE
            SET guild_id = EXCLUDED.guild_id,
                channel_id = EXCLUDED.channel_id,
                memory_version = EXCLUDED.memory_version,
                status = CASE
                  WHEN memory_embedding_jobs.memory_version
                       <> EXCLUDED.memory_version
                    OR memory_embedding_jobs.status = 'failed'
                    THEN 'pending'
                  ELSE memory_embedding_jobs.status
                END,
                attempts = CASE
                  WHEN memory_embedding_jobs.memory_version
                       <> EXCLUDED.memory_version
                    OR memory_embedding_jobs.status = 'failed'
                    THEN 0
                  ELSE memory_embedding_jobs.attempts
                END,
                available_at = CASE
                  WHEN memory_embedding_jobs.memory_version
                       <> EXCLUDED.memory_version
                    OR memory_embedding_jobs.status = 'failed'
                    THEN now()
                  ELSE memory_embedding_jobs.available_at
                END,
                locked_at = CASE
                  WHEN memory_embedding_jobs.memory_version
                       <> EXCLUDED.memory_version
                    OR memory_embedding_jobs.status = 'failed'
                    THEN NULL
                  ELSE memory_embedding_jobs.locked_at
                END,
                last_error_code = CASE
                  WHEN memory_embedding_jobs.memory_version
                       <> EXCLUDED.memory_version
                    OR memory_embedding_jobs.status = 'failed'
                    THEN NULL
                  ELSE memory_embedding_jobs.last_error_code
                END,
                completed_at = CASE
                  WHEN memory_embedding_jobs.memory_version
                       <> EXCLUDED.memory_version
                    OR memory_embedding_jobs.status = 'failed'
                    THEN NULL
                  ELSE memory_embedding_jobs.completed_at
                END
          `,
          [[...new Set(savedIds)], input.channelId],
        );
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

  async upsertMemoryLinks(input: {
    guildId: string;
    channelId: string;
    relations: MemoryRelationCandidate[];
  }): Promise<number> {
    if (input.relations.length === 0) return 0;
    const client = await this.pool.connect();
    let saved = 0;
    try {
      await client.query("BEGIN");
      for (const relation of input.relations.slice(0, 24)) {
        const fromScopeId = memoryIdentityScopeId(
          relation.from,
          input.guildId,
          input.channelId,
        );
        const toScopeId = memoryIdentityScopeId(
          relation.to,
          input.guildId,
          input.channelId,
        );
        if (!fromScopeId || !toScopeId) continue;
        const endpoints = await client.query<{ id: string; endpoint: string }>(
          `
            SELECT id, 'from'::text AS endpoint
            FROM memory_items
            WHERE guild_id = $1
              AND scope = $2
              AND scope_id = $3
              AND kind = $4
              AND memory_key = $5
              AND status = 'active'
            UNION ALL
            SELECT id, 'to'::text AS endpoint
            FROM memory_items
            WHERE guild_id = $1
              AND scope = $6
              AND scope_id = $7
              AND kind = $8
              AND memory_key = $9
              AND status = 'active'
          `,
          [
            input.guildId,
            relation.from.scope,
            fromScopeId,
            relation.from.kind,
            normalizeMemoryKey(relation.from.key),
            relation.to.scope,
            toScopeId,
            relation.to.kind,
            normalizeMemoryKey(relation.to.key),
          ],
        );
        const fromId = endpoints.rows.find(
          (endpoint) => endpoint.endpoint === "from",
        )?.id;
        const toId = endpoints.rows.find(
          (endpoint) => endpoint.endpoint === "to",
        )?.id;
        if (!fromId || !toId || fromId === toId) continue;
        const result = await client.query(
          `
            INSERT INTO memory_links (
              from_memory_id,
              to_memory_id,
              relation,
              confidence,
              evidence_message_ids
            )
            VALUES ($1, $2, $3, $4, $5::text[])
            ON CONFLICT (from_memory_id, to_memory_id, relation) DO UPDATE
            SET confidence = GREATEST(
                  memory_links.confidence,
                  EXCLUDED.confidence
                ),
                evidence_message_ids = ARRAY(
                  SELECT DISTINCT value
                  FROM unnest(
                    memory_links.evidence_message_ids
                    || EXCLUDED.evidence_message_ids
                  ) AS value
                  LIMIT 32
                ),
                updated_at = now()
          `,
          [
            fromId,
            toId,
            relation.relation,
            relation.confidence,
            relation.evidenceMessageIds,
          ],
        );
        saved += result.rowCount ?? 0;
      }
      await client.query("COMMIT");
      return saved;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
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
      await client.query(
        "DELETE FROM memory_embedding_jobs WHERE memory_item_id = $1",
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
          AND deleted_at IS NULL
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
    options: { maxAttempts?: number; retryDelayMs?: number } = {},
  ): Promise<void> {
    const maxAttempts = Math.max(1, Math.min(options.maxAttempts ?? 5, 100));
    const retryDelayMs = Math.max(
      1_000,
      Math.min(options.retryDelayMs ?? 30_000, 3_600_000),
    );
    await this.pool.query(
      `
        UPDATE memory_ingestion_jobs
        SET status = CASE WHEN attempts >= $3 THEN 'failed' ELSE 'pending' END,
            available_at = now()
              + $4 * interval '1 millisecond',
            locked_at = NULL,
            last_error_code = $2,
            completed_at = CASE WHEN attempts >= $3 THEN now() ELSE NULL END
        WHERE id = $1
      `,
      [
        job.id,
        errorCode.replace(/[^a-z0-9_.:-]/gi, "_").slice(0, 120),
        maxAttempts,
        retryDelayMs,
      ],
    );
  }

  async claimMemoryEmbeddingJobs(
    maximumJobs: number,
    model: string,
  ): Promise<MemoryEmbeddingJob[]> {
    const result = await this.pool.query<{
      memory_item_id: string;
      guild_id: string;
      channel_id: string;
      memory_version: number;
      kind: MemoryKind;
      memory_key: string;
      content: string;
      attempts: number;
    }>(
      `
        WITH candidates AS (
          SELECT jobs.memory_item_id
          FROM memory_embedding_jobs AS jobs
          INNER JOIN memory_items AS items
            ON items.id = jobs.memory_item_id
          WHERE items.status = 'active'
            AND (
              (
                jobs.status = 'pending'
                AND jobs.available_at <= now()
              )
              OR (
                jobs.status = 'processing'
                AND jobs.locked_at < now() - interval '5 minutes'
              )
              OR (
                jobs.status = 'completed'
                AND (
                  items.embedding IS NULL
                  OR items.embedding_model IS DISTINCT FROM $2
                  OR jobs.memory_version <> items.version
                )
              )
            )
          ORDER BY
            items.pinned DESC,
            items.importance DESC,
            jobs.available_at,
            jobs.memory_item_id
          FOR UPDATE OF jobs SKIP LOCKED
          LIMIT $1
        )
        UPDATE memory_embedding_jobs AS jobs
        SET status = 'processing',
            attempts = CASE
              WHEN jobs.status = 'completed'
                OR jobs.memory_version <> items.version
                THEN 1
              ELSE jobs.attempts + 1
            END,
            memory_version = items.version,
            locked_at = now(),
            last_error_code = NULL,
            completed_at = NULL
        FROM candidates
        INNER JOIN memory_items AS items
          ON items.id = candidates.memory_item_id
        WHERE jobs.memory_item_id = candidates.memory_item_id
        RETURNING
          jobs.memory_item_id,
          jobs.guild_id,
          jobs.channel_id,
          jobs.memory_version,
          items.kind,
          items.memory_key,
          items.content,
          jobs.attempts
      `,
      [maximumJobs, model],
    );
    return result.rows.map((row) => ({
      memoryItemId: Number(row.memory_item_id),
      guildId: row.guild_id,
      channelId: row.channel_id,
      memoryVersion: row.memory_version,
      kind: row.kind,
      key: row.memory_key,
      content: row.content,
      attempts: row.attempts,
    }));
  }

  async finishMemoryEmbeddingJobs(input: {
    jobs: MemoryEmbeddingJob[];
    vectors: number[][];
    model: string;
  }): Promise<number> {
    if (input.jobs.length !== input.vectors.length) {
      throw new Error("embedding job and vector counts must match");
    }
    const client = await this.pool.connect();
    let completed = 0;
    try {
      await client.query("BEGIN");
      for (const [index, job] of input.jobs.entries()) {
        const vector = input.vectors[index];
        if (!vector) continue;
        const updated = await client.query(
          `
            UPDATE memory_items
            SET embedding = $3::vector,
                embedding_model = $4,
                embedded_at = now()
            WHERE id = $1
              AND version = $2
              AND status = 'active'
          `,
          [
            job.memoryItemId,
            job.memoryVersion,
            vectorSql(vector),
            input.model,
          ],
        );
        if ((updated.rowCount ?? 0) > 0) completed += 1;
        await client.query(
          `
            UPDATE memory_embedding_jobs AS jobs
            SET status = CASE
                  WHEN items.version = $2
                    AND items.status = 'active'
                    AND $3::boolean
                    THEN 'completed'
                  ELSE 'pending'
                END,
                available_at = now(),
                locked_at = NULL,
                last_error_code = NULL,
                completed_at = CASE
                  WHEN items.version = $2
                    AND items.status = 'active'
                    AND $3::boolean
                    THEN now()
                  ELSE NULL
                END,
                memory_version = items.version
            FROM memory_items AS items
            WHERE jobs.memory_item_id = $1
              AND items.id = jobs.memory_item_id
          `,
          [
            job.memoryItemId,
            job.memoryVersion,
            (updated.rowCount ?? 0) > 0,
          ],
        );
      }
      await client.query("COMMIT");
      return completed;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async failMemoryEmbeddingJobs(
    jobs: MemoryEmbeddingJob[],
    errorCode: string,
  ): Promise<void> {
    if (jobs.length === 0) return;
    await this.pool.query(
      `
        UPDATE memory_embedding_jobs
        SET status = CASE WHEN attempts >= 8 THEN 'failed' ELSE 'pending' END,
            available_at = now()
              + LEAST(900, power(2, attempts)::integer) * interval '1 second',
            locked_at = NULL,
            last_error_code = $2,
            completed_at = CASE WHEN attempts >= 8 THEN now() ELSE NULL END
        WHERE memory_item_id = ANY($1::bigint[])
          AND status = 'processing'
      `,
      [
        jobs.map((job) => job.memoryItemId),
        errorCode.replace(/[^a-z0-9_.:-]/gi, "_").slice(0, 120),
      ],
    );
  }

  async claimAgentAction(input: {
    requestDiscordMessageId: string;
    toolName: string;
    argumentsHash: string;
    runId: string;
    callId: string;
  }): Promise<
    | { status: "execute" }
    | { status: "completed"; result: Record<string, unknown> }
    | { status: "in_progress" }
  > {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const existing = await client.query<{
        status: "started" | "completed" | "failed";
        result: unknown;
        lease_until: Date;
      }>(
        `
          SELECT status, result, lease_until
          FROM agent_action_receipts
          WHERE request_discord_message_id = $1
            AND tool_name = $2
            AND arguments_hash = $3
          FOR UPDATE
        `,
        [
          input.requestDiscordMessageId,
          input.toolName,
          input.argumentsHash,
        ],
      );
      const row = existing.rows[0];
      if (!row) {
        await client.query(
          `
            INSERT INTO agent_action_receipts (
              request_discord_message_id,
              tool_name,
              arguments_hash,
              run_id,
              call_id,
              status,
              lease_until
            )
            VALUES (
              $1, $2, $3, $4, $5, 'started', now() + interval '5 minutes'
            )
          `,
          [
            input.requestDiscordMessageId,
            input.toolName,
            input.argumentsHash,
            input.runId,
            input.callId,
          ],
        );
        await client.query("COMMIT");
        return { status: "execute" };
      }
      if (row.status === "completed") {
        await client.query("COMMIT");
        return {
          status: "completed",
          result:
            row.result &&
            typeof row.result === "object" &&
            !Array.isArray(row.result)
              ? (row.result as Record<string, unknown>)
              : {},
        };
      }
      if (row.status === "started" && row.lease_until.getTime() > Date.now()) {
        await client.query("COMMIT");
        return { status: "in_progress" };
      }
      await client.query(
        `
          UPDATE agent_action_receipts
          SET run_id = $4,
              call_id = $5,
              status = 'started',
              attempts = attempts + 1,
              result = NULL,
              error_code = NULL,
              lease_until = now() + interval '5 minutes',
              updated_at = now(),
              completed_at = NULL
          WHERE request_discord_message_id = $1
            AND tool_name = $2
            AND arguments_hash = $3
        `,
        [
          input.requestDiscordMessageId,
          input.toolName,
          input.argumentsHash,
          input.runId,
          input.callId,
        ],
      );
      await client.query("COMMIT");
      return { status: "execute" };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async completeAgentAction(input: {
    requestDiscordMessageId: string;
    toolName: string;
    argumentsHash: string;
    result: Record<string, unknown>;
  }): Promise<void> {
    await this.pool.query(
      `
        UPDATE agent_action_receipts
        SET status = 'completed',
            result = $4::jsonb,
            error_code = NULL,
            lease_until = now(),
            updated_at = now(),
            completed_at = now()
        WHERE request_discord_message_id = $1
          AND tool_name = $2
          AND arguments_hash = $3
          AND status = 'started'
      `,
      [
        input.requestDiscordMessageId,
        input.toolName,
        input.argumentsHash,
        JSON.stringify(input.result),
      ],
    );
  }

  async failAgentAction(input: {
    requestDiscordMessageId: string;
    toolName: string;
    argumentsHash: string;
    errorCode: string;
  }): Promise<void> {
    await this.pool.query(
      `
        UPDATE agent_action_receipts
        SET status = 'failed',
            error_code = $4,
            lease_until = now(),
            updated_at = now()
        WHERE request_discord_message_id = $1
          AND tool_name = $2
          AND arguments_hash = $3
          AND status = 'started'
      `,
      [
        input.requestDiscordMessageId,
        input.toolName,
        input.argumentsHash,
        input.errorCode.replace(/[^a-z0-9_.:-]/gi, "_").slice(0, 120),
      ],
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
    pendingEmbedding: number;
  }> {
    const result = await this.pool.query<{
      total: string;
      user_count: string;
      channel_count: string;
      guild_count: string;
      pending_ingestion: string;
      pending_embedding: string;
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
          ,
          (
            SELECT COUNT(*)
            FROM memory_embedding_jobs
            WHERE guild_id = $1
              AND status IN ('pending', 'processing')
          ) AS pending_embedding
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
      pendingEmbedding: Number(row?.pending_embedding ?? 0),
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
      | "memory_extract"
      | "memory_embed";
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
  semantic_similarity?: number | null;
  embedding_model?: string | null;
  embedded_at?: Date | null;
  linked_from_memory_id?: string | null;
  link_relation?: MemoryRelation | null;
  link_confidence?: number | null;
  link_direction?: "outbound" | "inbound" | null;
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
    ...(row.semantic_similarity !== undefined &&
    row.semantic_similarity !== null
      ? { semanticSimilarity: Number(row.semantic_similarity) }
      : {}),
    ...(row.embedding_model ? { embeddingModel: row.embedding_model } : {}),
    ...(row.embedded_at ? { embeddedAt: row.embedded_at } : {}),
    ...(row.linked_from_memory_id
      ? { linkedFromMemoryId: Number(row.linked_from_memory_id) }
      : {}),
    ...(row.link_relation ? { linkRelation: row.link_relation } : {}),
    ...(row.link_confidence !== undefined && row.link_confidence !== null
      ? { linkConfidence: Number(row.link_confidence) }
      : {}),
    ...(row.link_direction ? { linkDirection: row.link_direction } : {}),
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

function memoryIdentityScopeId(
  identity: MemoryIdentity,
  guildId: string,
  channelId: string,
): string | undefined {
  return identity.scope === "user"
    ? identity.subjectUserId
    : identity.scope === "channel"
      ? channelId
      : guildId;
}

function vectorSql(vector: number[]): string {
  if (
    vector.length !== 1_024 ||
    vector.some((value) => !Number.isFinite(value))
  ) {
    throw new Error("semantic-memory vectors must contain 1024 finite numbers");
  }
  return `[${vector.join(",")}]`;
}
