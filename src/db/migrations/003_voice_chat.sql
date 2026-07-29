ALTER TABLE ai_events DROP CONSTRAINT IF EXISTS ai_events_kind_check;

ALTER TABLE ai_events
  ADD CONSTRAINT ai_events_kind_check
  CHECK (kind IN ('chat', 'vision', 'summary', 'voice_stt', 'voice_chat'));
