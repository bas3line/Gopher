CREATE EXTENSION IF NOT EXISTS pg_trgm;

ALTER TABLE chat_messages
  ADD COLUMN IF NOT EXISTS reply_to_discord_message_id text,
  ADD COLUMN IF NOT EXISTS edited_at timestamptz,
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

CREATE TABLE IF NOT EXISTS chat_message_revisions (
  id bigserial PRIMARY KEY,
  chat_message_id bigint NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
  previous_content text NOT NULL,
  replacement_content text NOT NULL,
  edited_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS chat_message_revisions_message_idx
  ON chat_message_revisions (chat_message_id, id DESC);

CREATE TABLE IF NOT EXISTS discord_events (
  id bigserial PRIMARY KEY,
  event_key text NOT NULL UNIQUE,
  guild_id text NOT NULL,
  channel_id text NOT NULL,
  actor_user_id text,
  event_type text NOT NULL CHECK (
    event_type IN (
      'message_create',
      'message_edit',
      'message_delete',
      'reaction_add',
      'reaction_remove',
      'thread_create',
      'thread_update',
      'agent_action'
    )
  ),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS discord_events_channel_timeline_idx
  ON discord_events (guild_id, channel_id, occurred_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS discord_events_actor_timeline_idx
  ON discord_events (guild_id, actor_user_id, occurred_at DESC)
  WHERE actor_user_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS memory_items (
  id bigserial PRIMARY KEY,
  guild_id text NOT NULL,
  scope text NOT NULL CHECK (scope IN ('user', 'channel', 'guild')),
  scope_id text NOT NULL,
  subject_user_id text,
  kind text NOT NULL CHECK (
    kind IN (
      'profile',
      'preference',
      'fact',
      'decision',
      'project',
      'relationship',
      'commitment',
      'event',
      'skill',
      'correction'
    )
  ),
  memory_key text NOT NULL CHECK (
    memory_key ~ '^[a-z0-9][a-z0-9._:-]{1,119}$'
  ),
  content text NOT NULL CHECK (char_length(content) BETWEEN 3 AND 4000),
  importance smallint NOT NULL CHECK (importance BETWEEN 1 AND 10),
  confidence real NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  source text NOT NULL CHECK (source IN ('extracted', 'explicit', 'agent_tool', 'imported')),
  evidence_message_ids text[] NOT NULL DEFAULT ARRAY[]::text[],
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'active' CHECK (
    status IN ('active', 'superseded', 'forgotten')
  ),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  pinned boolean NOT NULL DEFAULT false,
  valid_from timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  last_confirmed_at timestamptz NOT NULL DEFAULT now(),
  last_accessed_at timestamptz,
  access_count integer NOT NULL DEFAULT 0 CHECK (access_count >= 0),
  superseded_by_id bigint REFERENCES memory_items(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  search_vector tsvector GENERATED ALWAYS AS (
    to_tsvector(
      'english',
      coalesce(memory_key, '') || ' ' || coalesce(content, '')
    )
  ) STORED
);

CREATE UNIQUE INDEX IF NOT EXISTS memory_items_active_key_idx
  ON memory_items (guild_id, scope, scope_id, kind, memory_key)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS memory_items_search_idx
  ON memory_items USING gin (search_vector);

CREATE INDEX IF NOT EXISTS memory_items_content_trgm_idx
  ON memory_items USING gin (content gin_trgm_ops);

CREATE INDEX IF NOT EXISTS memory_items_recall_idx
  ON memory_items (
    guild_id,
    status,
    scope,
    scope_id,
    importance DESC,
    updated_at DESC
  );

CREATE INDEX IF NOT EXISTS memory_items_subject_idx
  ON memory_items (guild_id, subject_user_id, status, updated_at DESC)
  WHERE subject_user_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS memory_item_revisions (
  id bigserial PRIMARY KEY,
  memory_item_id bigint NOT NULL REFERENCES memory_items(id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version > 0),
  previous_content text NOT NULL,
  previous_confidence real NOT NULL,
  previous_importance smallint NOT NULL,
  previous_status text NOT NULL,
  reason text NOT NULL,
  evidence_message_ids text[] NOT NULL DEFAULT ARRAY[]::text[],
  revised_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (memory_item_id, version)
);

CREATE INDEX IF NOT EXISTS memory_item_revisions_item_idx
  ON memory_item_revisions (memory_item_id, version DESC);

CREATE TABLE IF NOT EXISTS memory_links (
  from_memory_id bigint NOT NULL REFERENCES memory_items(id) ON DELETE CASCADE,
  to_memory_id bigint NOT NULL REFERENCES memory_items(id) ON DELETE CASCADE,
  relation text NOT NULL CHECK (
    relation IN (
      'supports',
      'contradicts',
      'updates',
      'part_of',
      'caused_by',
      'related_to'
    )
  ),
  confidence real NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (from_memory_id, to_memory_id, relation),
  CHECK (from_memory_id <> to_memory_id)
);

CREATE TABLE IF NOT EXISTS memory_ingestion_jobs (
  id bigserial PRIMARY KEY,
  guild_id text NOT NULL,
  channel_id text NOT NULL,
  through_message_id bigint NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'processing', 'completed', 'failed')
  ),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (guild_id, channel_id, through_message_id)
);

CREATE INDEX IF NOT EXISTS memory_ingestion_jobs_claim_idx
  ON memory_ingestion_jobs (available_at, id)
  WHERE status IN ('pending', 'processing');

CREATE TABLE IF NOT EXISTS memory_channel_checkpoints (
  guild_id text NOT NULL,
  channel_id text NOT NULL,
  last_message_id bigint NOT NULL CHECK (last_message_id >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (guild_id, channel_id)
);

CREATE TABLE IF NOT EXISTS agent_runs (
  id uuid PRIMARY KEY,
  guild_id text NOT NULL,
  channel_id text NOT NULL,
  user_id text NOT NULL,
  discord_message_id text NOT NULL,
  model text NOT NULL,
  status text NOT NULL CHECK (
    status IN ('running', 'completed', 'failed', 'cancelled')
  ),
  iterations integer NOT NULL DEFAULT 0 CHECK (iterations >= 0),
  tool_calls integer NOT NULL DEFAULT 0 CHECK (tool_calls >= 0),
  prompt_tokens integer,
  completion_tokens integer,
  error_code text,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE INDEX IF NOT EXISTS agent_runs_channel_idx
  ON agent_runs (guild_id, channel_id, started_at DESC);

CREATE TABLE IF NOT EXISTS agent_tool_calls (
  id bigserial PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  call_id text NOT NULL,
  iteration integer NOT NULL CHECK (iteration > 0),
  tool_name text NOT NULL,
  effect text NOT NULL CHECK (effect IN ('read', 'write', 'unknown')),
  success boolean NOT NULL,
  cached boolean NOT NULL DEFAULT false,
  duration_ms integer NOT NULL CHECK (duration_ms >= 0),
  error_code text,
  output_preview text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, call_id)
);

CREATE INDEX IF NOT EXISTS agent_tool_calls_run_idx
  ON agent_tool_calls (run_id, iteration, id);

ALTER TABLE ai_events DROP CONSTRAINT IF EXISTS ai_events_kind_check;

ALTER TABLE ai_events
  ADD CONSTRAINT ai_events_kind_check
  CHECK (
    kind IN (
      'chat',
      'vision',
      'summary',
      'voice_stt',
      'voice_chat',
      'agent',
      'memory_extract'
    )
  );
