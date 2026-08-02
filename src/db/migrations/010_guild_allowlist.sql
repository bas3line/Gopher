CREATE TABLE IF NOT EXISTS guild_allowlist (
  guild_id text PRIMARY KEY,
  added_by text NOT NULL,
  added_at timestamptz NOT NULL DEFAULT now()
);
