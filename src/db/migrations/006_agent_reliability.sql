CREATE TABLE IF NOT EXISTS agent_action_receipts (
  request_discord_message_id text NOT NULL,
  tool_name text NOT NULL,
  arguments_hash text NOT NULL CHECK (
    arguments_hash ~ '^[a-f0-9]{64}$'
  ),
  run_id uuid NOT NULL,
  call_id text NOT NULL,
  status text NOT NULL CHECK (
    status IN ('started', 'completed', 'failed')
  ),
  attempts integer NOT NULL DEFAULT 1 CHECK (attempts > 0),
  result jsonb,
  error_code text,
  lease_until timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY (
    request_discord_message_id,
    tool_name,
    arguments_hash
  )
);

CREATE INDEX IF NOT EXISTS agent_action_receipts_lease_idx
  ON agent_action_receipts (lease_until)
  WHERE status = 'started';
