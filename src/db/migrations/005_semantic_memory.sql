CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE memory_items
  ADD COLUMN IF NOT EXISTS embedding vector(1024),
  ADD COLUMN IF NOT EXISTS embedding_model text,
  ADD COLUMN IF NOT EXISTS embedded_at timestamptz;

CREATE INDEX IF NOT EXISTS memory_items_embedding_hnsw_idx
  ON memory_items
  USING hnsw (embedding vector_cosine_ops)
  WHERE status = 'active' AND embedding IS NOT NULL;

CREATE TABLE IF NOT EXISTS memory_embedding_jobs (
  memory_item_id bigint PRIMARY KEY REFERENCES memory_items(id) ON DELETE CASCADE,
  guild_id text NOT NULL,
  channel_id text NOT NULL,
  memory_version integer NOT NULL CHECK (memory_version > 0),
  status text NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'processing', 'completed', 'failed')
  ),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE INDEX IF NOT EXISTS memory_embedding_jobs_claim_idx
  ON memory_embedding_jobs (available_at, memory_item_id)
  WHERE status IN ('pending', 'processing', 'completed');

INSERT INTO memory_embedding_jobs (
  memory_item_id,
  guild_id,
  channel_id,
  memory_version
)
SELECT
  id,
  guild_id,
  CASE WHEN scope = 'channel' THEN scope_id ELSE guild_id END,
  version
FROM memory_items
WHERE status = 'active'
ON CONFLICT (memory_item_id) DO NOTHING;

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
      'memory_extract',
      'memory_embed'
    )
  );
