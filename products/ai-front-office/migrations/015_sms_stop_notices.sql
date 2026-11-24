BEGIN;

-- Which owner text carried a number's "Reply STOP to opt out" line. One row per number (hashed, never the
-- number itself): the first notification to claim it adds the line, retries of that same notification add it
-- again, and every other notification skips it. A START reply, a new opt-in, or the
-- holder going dead deletes the row so the next text carries it.
CREATE TABLE IF NOT EXISTS sms_stop_notices (
  phone_hash text PRIMARY KEY,
  notification_id text NOT NULL,
  claimed_at timestamptz NOT NULL
);
-- A notification that goes dead gives its notice back (looked up by notification id).
CREATE INDEX IF NOT EXISTS sms_stop_notices_notification_idx ON sms_stop_notices(notification_id);

COMMIT;
