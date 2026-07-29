CREATE TABLE IF NOT EXISTS music_guild_settings (
  guild_id text PRIMARY KEY,
  volume integer NOT NULL DEFAULT 65 CHECK (volume BETWEEN 0 AND 200),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS music_queue_items (
  id bigserial PRIMARY KEY,
  guild_id text NOT NULL,
  requested_by_user_id text NOT NULL,
  requested_by_username text NOT NULL,
  source_query text NOT NULL,
  encoded_track text NOT NULL,
  title text NOT NULL,
  author text NOT NULL DEFAULT '',
  uri text,
  artwork_url text,
  duration_ms bigint NOT NULL CHECK (duration_ms >= 0),
  queue_state text NOT NULL DEFAULT 'queued'
    CHECK (queue_state IN ('queued', 'playing', 'played', 'skipped', 'failed')),
  queue_order integer NOT NULL CHECK (queue_order > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS music_queue_active_order_idx
  ON music_queue_items (guild_id, queue_order)
  WHERE queue_state IN ('queued', 'playing');

CREATE UNIQUE INDEX IF NOT EXISTS music_queue_one_playing_idx
  ON music_queue_items (guild_id)
  WHERE queue_state = 'playing';

CREATE INDEX IF NOT EXISTS music_queue_guild_state_idx
  ON music_queue_items (guild_id, queue_state, queue_order);

CREATE INDEX IF NOT EXISTS music_queue_history_idx
  ON music_queue_items (guild_id, completed_at DESC)
  WHERE queue_state IN ('played', 'skipped', 'failed');
