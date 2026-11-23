BEGIN;

ALTER TABLE notification_outbox
  ALTER COLUMN call_id DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS sender_ref text NOT NULL DEFAULT 'default';

COMMIT;
