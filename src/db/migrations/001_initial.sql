CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id bigserial PRIMARY KEY,
  discord_message_id text NOT NULL UNIQUE,
  guild_id text NOT NULL,
  channel_id text NOT NULL,
  user_id text NOT NULL,
  username text NOT NULL,
  role text NOT NULL CHECK (role IN ('user', 'assistant')),
  content text NOT NULL,
  attachments jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  search_vector tsvector GENERATED ALWAYS AS (
    to_tsvector('english', coalesce(username, '') || ' ' || coalesce(content, ''))
  ) STORED
);

CREATE INDEX IF NOT EXISTS chat_messages_channel_recent_idx
  ON chat_messages (guild_id, channel_id, id DESC);

CREATE INDEX IF NOT EXISTS chat_messages_search_idx
  ON chat_messages USING gin (search_vector);

CREATE TABLE IF NOT EXISTS conversation_summaries (
  guild_id text NOT NULL,
  channel_id text NOT NULL,
  summary text NOT NULL,
  last_message_id bigint NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (guild_id, channel_id)
);

CREATE TABLE IF NOT EXISTS web_documents (
  id bigserial PRIMARY KEY,
  query text NOT NULL,
  url text NOT NULL UNIQUE,
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  content text NOT NULL DEFAULT '',
  published_at text,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  search_vector tsvector GENERATED ALWAYS AS (
    to_tsvector(
      'english',
      coalesce(title, '') || ' ' || coalesce(description, '') || ' ' || coalesce(content, '')
    )
  ) STORED
);

CREATE INDEX IF NOT EXISTS web_documents_search_idx
  ON web_documents USING gin (search_vector);

CREATE TABLE IF NOT EXISTS ai_events (
  id bigserial PRIMARY KEY,
  guild_id text NOT NULL,
  channel_id text NOT NULL,
  user_id text NOT NULL,
  model text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('chat', 'vision', 'summary')),
  success boolean NOT NULL,
  latency_ms integer NOT NULL,
  prompt_tokens integer,
  completion_tokens integer,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ai_events_created_idx ON ai_events (created_at DESC);
