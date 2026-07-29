import type { DatabasePool } from "../db/pool.ts";
import type {
  ConversationSummary,
  RelevantMemory,
  StoredMessage,
  WebSource,
} from "../types.ts";

interface RecordMessageInput {
  discordMessageId: string;
  guildId: string;
  channelId: string;
  userId: string;
  username: string;
  role: "user" | "assistant";
  content: string;
  attachments?: Array<{ url: string; name: string; contentType?: string }>;
}

export class MemoryStore {
  constructor(private readonly pool: DatabasePool) {}

  async recordMessage(input: RecordMessageInput): Promise<number | undefined> {
    const result = await this.pool.query<{ id: string }>(
      `
        INSERT INTO chat_messages (
          discord_message_id, guild_id, channel_id, user_id, username, role, content, attachments
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
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
      ],
    );
    const row = result.rows[0];
    return row ? Number(row.id) : undefined;
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

  async recordAIEvent(input: {
    guildId: string;
    channelId: string;
    userId: string;
    model: string;
    kind: "chat" | "vision" | "summary";
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
