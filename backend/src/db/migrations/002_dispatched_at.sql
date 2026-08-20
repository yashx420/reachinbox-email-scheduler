-- ---------------------------------------------------------------------------
-- 002: record when a send *started*, not just when it finished.
--
-- MIN_DELAY_BETWEEN_EMAILS_MS is a guarantee about how often the system hands
-- a message to SMTP. `sent_at` cannot show that, because with
-- WORKER_CONCURRENCY > 1 a slow round trip finishes after a later, faster one.
-- `dispatched_at` makes the spacing directly observable (and testable).
-- ---------------------------------------------------------------------------

ALTER TABLE email_jobs ADD COLUMN IF NOT EXISTS dispatched_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS email_jobs_dispatched_idx
  ON email_jobs (dispatched_at DESC)
  WHERE dispatched_at IS NOT NULL;
