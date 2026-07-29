import { describe, expect, test } from "bun:test";
import type { DatabasePool } from "../src/db/pool.ts";
import { MusicStore } from "../src/music/store.ts";

const queueRow = {
  id: "1",
  guild_id: "guild",
  requested_by_user_id: "user",
  requested_by_username: "shubham",
  source_query: "chill music mix",
  encoded_track: "encoded",
  title: "track",
  author: "artist",
  uri: null,
  artwork_url: null,
  duration_ms: "120000",
  queue_state: "queued" as const,
  queue_order: 1,
  created_at: new Date("2026-01-01T00:00:00.000Z"),
  started_at: null,
  completed_at: null,
};

function storeWithTransactionQueries() {
  const queries: string[] = [];
  const client = {
    async query(query: string) {
      queries.push(query);
      if (query.includes("UPDATE music_queue_items AS item") || query.includes("DELETE FROM music_queue_items AS item")) {
        return { rows: [queueRow] };
      }
      return { rows: [] };
    },
    release() {},
  };
  const pool = {
    async connect() {
      return client;
    },
  };
  return {
    queries,
    store: new MusicStore(pool as unknown as DatabasePool),
  };
}

describe("music queue SQL", () => {
  test("qualifies queue columns when an update CTE also exposes id", async () => {
    const { store, queries } = storeWithTransactionQueries();

    const next = await store.next("guild");

    expect(next?.id).toBe(1);
    expect(queries.find((query) => query.includes("UPDATE music_queue_items AS item"))).toContain(
      "RETURNING \n  item.id,",
    );
  });

  test("qualifies queue columns when deleting through a selected-item CTE", async () => {
    const { store, queries } = storeWithTransactionQueries();

    const removed = await store.removeUpcoming("guild", 1);

    expect(removed?.id).toBe(1);
    expect(queries.find((query) => query.includes("DELETE FROM music_queue_items AS item"))).toContain(
      "RETURNING \n  item.id,",
    );
  });
});
