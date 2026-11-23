BEGIN;

ALTER TABLE calls
  ADD COLUMN IF NOT EXISTS from_number_verified boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS deleted_provider_calls (
  provider_call_id text PRIMARY KEY,
  tenant_id text NOT NULL,
  deleted_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS notification_outbox_call_idx
  ON notification_outbox(call_id, created_at);

CREATE UNIQUE INDEX IF NOT EXISTS notification_outbox_provider_receipt_idx
  ON notification_outbox(provider_receipt)
  WHERE provider_receipt IS NOT NULL;

CREATE TABLE IF NOT EXISTS sms_opt_outs (
  tenant_id text NOT NULL REFERENCES business_configs(tenant_id) ON DELETE CASCADE,
  phone_hash text NOT NULL,
  opted_out boolean NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, phone_hash)
);

CREATE INDEX IF NOT EXISTS webhook_events_received_idx
  ON webhook_events(received_at);

CREATE INDEX IF NOT EXISTS calls_tenant_outcome_updated_idx
  ON calls(tenant_id, outcome, updated_at);

CREATE INDEX IF NOT EXISTS calls_tenant_ended_idx
  ON calls(tenant_id, ended_at)
  WHERE ended_at IS NOT NULL;

CREATE EXTENSION IF NOT EXISTS btree_gist;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'booking_no_overlap') THEN
    ALTER TABLE booking_requests
      ADD CONSTRAINT booking_no_overlap
      EXCLUDE USING gist (
        tenant_id WITH =,
        tstzrange(requested_start, requested_end, '[)') WITH &&
      )
      WHERE (status = 'confirmed');
  END IF;
END $$;

COMMIT;
