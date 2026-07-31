ALTER TABLE memory_links
  ADD COLUMN IF NOT EXISTS evidence_message_ids text[] NOT NULL
    DEFAULT ARRAY[]::text[],
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS memory_links_to_idx
  ON memory_links (to_memory_id, confidence DESC);

CREATE INDEX IF NOT EXISTS memory_links_from_idx
  ON memory_links (from_memory_id, confidence DESC);

CREATE TABLE IF NOT EXISTS memory_link_revisions (
  id bigserial PRIMARY KEY,
  from_memory_id bigint NOT NULL,
  to_memory_id bigint NOT NULL,
  relation text NOT NULL,
  previous_confidence real NOT NULL,
  previous_evidence_message_ids text[] NOT NULL DEFAULT ARRAY[]::text[],
  reason text NOT NULL,
  revised_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS memory_link_revisions_edge_idx
  ON memory_link_revisions (
    from_memory_id,
    to_memory_id,
    relation,
    revised_at DESC
  );
