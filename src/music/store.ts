import type { PoolClient } from "pg";
import type { DatabasePool } from "../db/pool.ts";
import type {
  MusicQueueSnapshot,
  MusicQueueState,
  QueuedMusicTrack,
  ResolvedMusicTrack,
} from "./types.ts";

interface MusicQueueRow {
  id: string;
  guild_id: string;
  requested_by_user_id: string;
  requested_by_username: string;
  source_query: string;
  encoded_track: string;
  title: string;
  author: string;
  uri: string | null;
  artwork_url: string | null;
  duration_ms: string;
  queue_state: MusicQueueState;
  queue_order: number;
  created_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
}

const queueColumns = `
  id, guild_id, requested_by_user_id, requested_by_username, source_query,
  encoded_track, title, author, uri, artwork_url, duration_ms, queue_state,
  queue_order, created_at, started_at, completed_at
`;
const historyRetentionLimit = 100;

export class MusicQueueLimitError extends Error {}

export class MusicStore {
  constructor(
    private readonly pool: DatabasePool,
    private readonly defaultVolume = 65,
  ) {}

  async recoverInterruptedPlayback(): Promise<number> {
    const result = await this.pool.query(
      `UPDATE music_queue_items
       SET queue_state = 'queued', started_at = NULL
       WHERE queue_state = 'playing'`,
    );
    return result.rowCount ?? 0;
  }

  async enqueue(
    guildId: string,
    request: { userId: string; username: string; query: string },
    tracks: readonly ResolvedMusicTrack[],
    maximumQueueLength: number,
  ): Promise<QueuedMusicTrack[]> {
    if (tracks.length === 0) return [];
    return await this.withGuildTransaction(guildId, async (client) => {
      const pending = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count
         FROM music_queue_items
         WHERE guild_id = $1 AND queue_state IN ('queued', 'playing')`,
        [guildId],
      );
      if (Number(pending.rows[0]?.count ?? 0) + tracks.length > maximumQueueLength) {
        throw new MusicQueueLimitError(`queue is capped at ${maximumQueueLength} tracks`);
      }

      await client.query(
        `INSERT INTO music_guild_settings (guild_id)
         VALUES ($1) ON CONFLICT (guild_id) DO NOTHING`,
        [guildId],
      );
      const last = await client.query<{ queue_order: number }>(
        `SELECT queue_order
         FROM music_queue_items
         WHERE guild_id = $1 AND queue_state IN ('queued', 'playing')
         ORDER BY queue_order DESC
         LIMIT 1
         FOR UPDATE`,
        [guildId],
      );
      let queueOrder = (last.rows[0]?.queue_order ?? 0) + 1;
      const added: QueuedMusicTrack[] = [];
      for (const track of tracks) {
        const result = await client.query<MusicQueueRow>(
          `INSERT INTO music_queue_items (
             guild_id, requested_by_user_id, requested_by_username, source_query,
             encoded_track, title, author, uri, artwork_url, duration_ms, queue_order
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
           RETURNING ${queueColumns}`,
          [
            guildId,
            request.userId,
            request.username,
            request.query,
            track.encodedTrack,
            track.title,
            track.author,
            track.uri ?? null,
            track.artworkUrl ?? null,
            track.durationMs,
            queueOrder++,
          ],
        );
        added.push(toQueueItem(requiredRow(result)));
      }
      return added;
    });
  }

  async snapshot(guildId: string): Promise<MusicQueueSnapshot> {
    const [items, volume] = await Promise.all([
      this.pool.query<MusicQueueRow>(
        `SELECT ${queueColumns}
         FROM music_queue_items
         WHERE guild_id = $1 AND queue_state IN ('playing', 'queued')
         ORDER BY CASE queue_state WHEN 'playing' THEN 0 ELSE 1 END, queue_order ASC`,
        [guildId],
      ),
      this.volume(guildId),
    ]);
    const queue = items.rows.map(toQueueItem);
    return {
      ...(queue[0]?.state === "playing" ? { current: queue[0] } : {}),
      upcoming: queue.filter((item) => item.state === "queued"),
      volume,
    };
  }

  async next(guildId: string): Promise<QueuedMusicTrack | undefined> {
    return await this.withGuildTransaction(guildId, async (client) => {
      const result = await client.query<MusicQueueRow>(
        `WITH next_item AS (
           SELECT id
           FROM music_queue_items
           WHERE guild_id = $1 AND queue_state = 'queued'
           ORDER BY queue_order ASC
           LIMIT 1
           FOR UPDATE SKIP LOCKED
         )
         UPDATE music_queue_items AS item
         SET queue_state = 'playing', started_at = now(), completed_at = NULL
         FROM next_item
         WHERE item.id = next_item.id
         RETURNING ${queueColumns}`,
        [guildId],
      );
      return result.rows[0] ? toQueueItem(result.rows[0]) : undefined;
    });
  }

  async finishCurrent(
    guildId: string,
    state: Extract<MusicQueueState, "played" | "skipped" | "failed">,
  ): Promise<QueuedMusicTrack | undefined> {
    return await this.withGuildTransaction(guildId, async (client) => {
      const result = await client.query<MusicQueueRow>(
        `UPDATE music_queue_items
         SET queue_state = $2, completed_at = now()
         WHERE id = (
           SELECT id FROM music_queue_items
           WHERE guild_id = $1 AND queue_state = 'playing'
           ORDER BY queue_order ASC
           LIMIT 1
           FOR UPDATE SKIP LOCKED
         )
         RETURNING ${queueColumns}`,
        [guildId, state],
      );
      await this.pruneHistory(client, guildId);
      return result.rows[0] ? toQueueItem(result.rows[0]) : undefined;
    });
  }

  async clear(guildId: string): Promise<number> {
    return await this.withGuildTransaction(guildId, async (client) => {
      const result = await client.query(
        `UPDATE music_queue_items
         SET queue_state = 'skipped', completed_at = now()
         WHERE guild_id = $1 AND queue_state IN ('playing', 'queued')`,
        [guildId],
      );
      await this.pruneHistory(client, guildId);
      return result.rowCount ?? 0;
    });
  }

  async removeUpcoming(guildId: string, position: number): Promise<QueuedMusicTrack | undefined> {
    return await this.withGuildTransaction(guildId, async (client) => {
      const result = await client.query<MusicQueueRow>(
        `WITH selected AS (
           SELECT id
           FROM music_queue_items
           WHERE guild_id = $1 AND queue_state = 'queued'
           ORDER BY queue_order ASC
           OFFSET GREATEST($2 - 1, 0)
           LIMIT 1
           FOR UPDATE
         )
         DELETE FROM music_queue_items AS item
         USING selected
         WHERE item.id = selected.id
         RETURNING ${queueColumns}`,
        [guildId, position],
      );
      return result.rows[0] ? toQueueItem(result.rows[0]) : undefined;
    });
  }

  async shuffleUpcoming(guildId: string): Promise<number> {
    return await this.withGuildTransaction(guildId, async (client) => {
      const result = await client.query<{ id: string; queue_order: number; queue_state: MusicQueueState }>(
        `SELECT id, queue_order, queue_state FROM music_queue_items
         WHERE guild_id = $1 AND queue_state = 'queued'
         ORDER BY queue_order ASC
         FOR UPDATE`,
        [guildId],
      );
      const current = await client.query<{ queue_order: number }>(
        `SELECT queue_order FROM music_queue_items
         WHERE guild_id = $1 AND queue_state = 'playing'
         FOR UPDATE`,
        [guildId],
      );
      const ids = shuffle(result.rows.map((row) => row.id));
      const highestOrder = Math.max(
        current.rows[0]?.queue_order ?? 0,
        ...result.rows.map((row) => row.queue_order),
      );
      const temporaryStart = highestOrder + ids.length + 1;
      for (const [index, id] of ids.entries()) {
        await client.query(
          "UPDATE music_queue_items SET queue_order = $2 WHERE id = $1",
          [id, temporaryStart + index],
        );
      }
      const firstQueueOrder = (current.rows[0]?.queue_order ?? 0) + 1;
      for (const [index, id] of ids.entries()) {
        await client.query(
          "UPDATE music_queue_items SET queue_order = $2 WHERE id = $1",
          [id, firstQueueOrder + index],
        );
      }
      return ids.length;
    });
  }

  async history(guildId: string, limit = 8): Promise<QueuedMusicTrack[]> {
    const result = await this.pool.query<MusicQueueRow>(
      `SELECT ${queueColumns}
       FROM music_queue_items
       WHERE guild_id = $1 AND queue_state IN ('played', 'skipped', 'failed')
       ORDER BY completed_at DESC NULLS LAST
       LIMIT $2`,
      [guildId, limit],
    );
    return result.rows.map(toQueueItem);
  }

  async volume(guildId: string): Promise<number> {
    const result = await this.pool.query<{ volume: number }>(
      "SELECT volume FROM music_guild_settings WHERE guild_id = $1",
      [guildId],
    );
    return result.rows[0]?.volume ?? this.defaultVolume;
  }

  async setVolume(guildId: string, volume: number): Promise<void> {
    await this.pool.query(
      `INSERT INTO music_guild_settings (guild_id, volume)
       VALUES ($1, $2)
       ON CONFLICT (guild_id)
       DO UPDATE SET volume = EXCLUDED.volume, updated_at = now()`,
      [guildId, volume],
    );
  }

  private async withGuildTransaction<T>(
    guildId: string,
    operation: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    let committed = false;
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [guildId]);
      const result = await operation(client);
      await client.query("COMMIT");
      committed = true;
      return result;
    } catch (error) {
      if (!committed) await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async pruneHistory(client: PoolClient, guildId: string): Promise<void> {
    await client.query(
      `DELETE FROM music_queue_items
       WHERE id IN (
         SELECT id
         FROM music_queue_items
         WHERE guild_id = $1 AND queue_state IN ('played', 'skipped', 'failed')
         ORDER BY completed_at DESC NULLS LAST, id DESC
         OFFSET $2
       )`,
      [guildId, historyRetentionLimit],
    );
  }
}

function requiredRow<T extends { rows: unknown[] }>(result: T): MusicQueueRow {
  const row = result.rows[0] as MusicQueueRow | undefined;
  if (!row) throw new Error("music queue insert returned no row");
  return row;
}

function toQueueItem(row: MusicQueueRow): QueuedMusicTrack {
  return {
    id: Number(row.id),
    guildId: row.guild_id,
    requestedByUserId: row.requested_by_user_id,
    requestedByUsername: row.requested_by_username,
    sourceQuery: row.source_query,
    encodedTrack: row.encoded_track,
    title: row.title,
    author: row.author,
    ...(row.uri ? { uri: row.uri } : {}),
    ...(row.artwork_url ? { artworkUrl: row.artwork_url } : {}),
    durationMs: Number(row.duration_ms),
    state: row.queue_state,
    queueOrder: row.queue_order,
    createdAt: row.created_at,
    ...(row.started_at ? { startedAt: row.started_at } : {}),
    ...(row.completed_at ? { completedAt: row.completed_at } : {}),
  };
}

function shuffle<T>(items: readonly T[]): T[] {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const target = Math.floor(Math.random() * (index + 1));
    [result[index], result[target]] = [result[target]!, result[index]!];
  }
  return result;
}
