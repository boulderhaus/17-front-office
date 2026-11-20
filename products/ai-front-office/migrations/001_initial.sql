BEGIN;

CREATE TABLE IF NOT EXISTS business_configs (
  tenant_id text PRIMARY KEY,
  config jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS integration_secrets (
  tenant_id text NOT NULL REFERENCES business_configs(tenant_id) ON DELETE CASCADE,
  provider text NOT NULL,
  secret_key text NOT NULL,
  value_ciphertext text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id, provider, secret_key)
);

CREATE TABLE IF NOT EXISTS calls (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES business_configs(tenant_id) ON DELETE CASCADE,
  provider_call_id text NOT NULL UNIQUE,
  from_number_hash text NOT NULL,
  from_number_ciphertext text NOT NULL,
  started_at timestamptz NOT NULL,
  ended_at timestamptz,
  duration_seconds integer,
  fields_ciphertext text NOT NULL,
  emergency jsonb,
  outcome text NOT NULL,
  transcript_ciphertext text,
  recording_url_ciphertext text,
  consent_state text NOT NULL,
  billing_disposition text NOT NULL,
  quality_flags jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS calls_tenant_started_idx ON calls(tenant_id, started_at DESC);

CREATE TABLE IF NOT EXISTS customers (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES business_configs(tenant_id) ON DELETE CASCADE,
  phone_hash text NOT NULL,
  phone_ciphertext text NOT NULL,
  name_ciphertext text,
  address_ciphertext text,
  last_call_id uuid NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE(tenant_id, phone_hash)
);

CREATE TABLE IF NOT EXISTS booking_requests (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES business_configs(tenant_id) ON DELETE CASCADE,
  call_id uuid NOT NULL UNIQUE REFERENCES calls(id) ON DELETE CASCADE,
  requested_start timestamptz,
  requested_end timestamptz,
  status text NOT NULL,
  provider_event_id text,
  write_verified_at timestamptz,
  confirmation_notification_id uuid,
  verification_failures jsonb NOT NULL DEFAULT '[]'::jsonb,
  failure_reason text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS booking_confirmed_slot_idx
  ON booking_requests(tenant_id, requested_start, requested_end)
  WHERE status = 'confirmed';

CREATE TABLE IF NOT EXISTS callback_tasks (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES business_configs(tenant_id) ON DELETE CASCADE,
  call_id uuid NOT NULL UNIQUE REFERENCES calls(id) ON DELETE CASCADE,
  owner_ref text NOT NULL,
  reason text NOT NULL,
  priority text NOT NULL,
  status text NOT NULL,
  due_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS callback_tasks_due_idx ON callback_tasks(status, due_at);

CREATE TABLE IF NOT EXISTS tool_events (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  call_id uuid NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  tool text NOT NULL,
  started_at timestamptz NOT NULL,
  completed_at timestamptz NOT NULL,
  latency_ms integer NOT NULL,
  result text NOT NULL,
  metadata jsonb NOT NULL,
  redacted_error text
);
CREATE INDEX IF NOT EXISTS tool_events_call_idx ON tool_events(call_id, started_at);

CREATE TABLE IF NOT EXISTS notification_outbox (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  call_id uuid NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  channel text NOT NULL,
  destination_ref_ciphertext text NOT NULL,
  body_ciphertext text NOT NULL,
  priority text NOT NULL,
  state text NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  provider_receipt text,
  last_error text,
  created_at timestamptz NOT NULL,
  sent_at timestamptz,
  sending_at timestamptz
);
CREATE INDEX IF NOT EXISTS notification_due_idx ON notification_outbox(state, next_attempt_at);

CREATE TABLE IF NOT EXISTS webhook_events (
  event_id text PRIMARY KEY,
  received_at timestamptz NOT NULL DEFAULT now()
);

COMMIT;
