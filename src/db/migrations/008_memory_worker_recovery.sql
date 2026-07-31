UPDATE memory_ingestion_jobs
SET status = 'pending',
    attempts = 0,
    available_at = now(),
    locked_at = NULL,
    last_error_code = NULL,
    completed_at = NULL
WHERE status = 'failed'
  AND last_error_code IN ('invalid_output', 'provider_failure');
