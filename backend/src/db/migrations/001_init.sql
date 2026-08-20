-- ---------------------------------------------------------------------------
-- 001_init: users, SMTP senders, campaigns and the individual email jobs.
--
-- The DB is the source of truth for *what* must be sent; Redis/BullMQ only
-- decides *when* a job runs. That split is what makes a restart safe: we can
-- always rebuild the queue from these tables (see queue/reconciler.ts).
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  google_id     TEXT NOT NULL UNIQUE,
  email         TEXT NOT NULL UNIQUE,
  name          TEXT,
  avatar_url    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per outbound mailbox. Multiple senders let us spread load and apply
-- a per-sender hourly cap, the way a real warm-up pool works.
CREATE TABLE IF NOT EXISTS senders (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  label               TEXT NOT NULL UNIQUE,
  host                TEXT NOT NULL,
  port                INTEGER NOT NULL DEFAULT 587,
  secure              BOOLEAN NOT NULL DEFAULT FALSE,
  username            TEXT NOT NULL,
  password            TEXT NOT NULL,
  from_email          TEXT NOT NULL,
  from_name           TEXT NOT NULL DEFAULT 'ReachInbox',
  -- NULL => fall back to MAX_EMAILS_PER_HOUR_PER_SENDER from the environment.
  max_emails_per_hour INTEGER,
  web_url             TEXT,
  is_active           BOOLEAN NOT NULL DEFAULT TRUE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS campaigns (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                 UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name                    TEXT,
  subject                 TEXT NOT NULL,
  body                    TEXT NOT NULL,
  start_at                TIMESTAMPTZ NOT NULL,
  delay_between_emails_ms INTEGER NOT NULL DEFAULT 2000,
  hourly_limit            INTEGER,
  total_recipients        INTEGER NOT NULL DEFAULT 0,
  -- Client supplied key: replaying the same schedule request is a no-op.
  idempotency_key         TEXT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS campaigns_user_idempotency_key_idx
  ON campaigns (user_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- One row == one email to one recipient == one BullMQ job (job id == this id).
CREATE TABLE IF NOT EXISTS email_jobs (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id           UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  user_id               UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sender_id             UUID REFERENCES senders(id) ON DELETE SET NULL,
  recipient_email       TEXT NOT NULL,
  recipient_name        TEXT,
  subject               TEXT NOT NULL,
  body                  TEXT NOT NULL,
  -- Position within the campaign. Preserves send order when a job gets pushed
  -- into a later rate-limit window.
  sequence              INTEGER NOT NULL DEFAULT 0,
  scheduled_at          TIMESTAMPTZ NOT NULL,
  original_scheduled_at TIMESTAMPTZ NOT NULL,
  status                TEXT NOT NULL DEFAULT 'scheduled'
                          CHECK (status IN ('scheduled','rate_limited','processing','sent','failed','cancelled')),
  attempts              INTEGER NOT NULL DEFAULT 0,
  defer_count           INTEGER NOT NULL DEFAULT 0,
  locked_at             TIMESTAMPTZ,
  sent_at               TIMESTAMPTZ,
  message_id            TEXT,
  preview_url           TEXT,
  last_error            TEXT,
  -- Guarantees "one email per recipient per campaign" even if the API is
  -- called twice; the queue job id is derived from the row id on top of that.
  idempotency_key       TEXT NOT NULL UNIQUE,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS email_jobs_pending_idx
  ON email_jobs (status, scheduled_at)
  WHERE status IN ('scheduled', 'rate_limited', 'processing');

CREATE INDEX IF NOT EXISTS email_jobs_user_status_idx ON email_jobs (user_id, status, scheduled_at DESC);
CREATE INDEX IF NOT EXISTS email_jobs_sent_idx        ON email_jobs (user_id, sent_at DESC) WHERE status = 'sent';
CREATE INDEX IF NOT EXISTS email_jobs_campaign_idx    ON email_jobs (campaign_id, sequence);

-- Keeps updated_at honest without every UPDATE having to remember it.
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS email_jobs_set_updated_at ON email_jobs;
CREATE TRIGGER email_jobs_set_updated_at
  BEFORE UPDATE ON email_jobs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS senders_set_updated_at ON senders;
CREATE TRIGGER senders_set_updated_at
  BEFORE UPDATE ON senders
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
