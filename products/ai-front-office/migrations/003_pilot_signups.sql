BEGIN;

CREATE TABLE IF NOT EXISTS pilot_signups (
  id uuid PRIMARY KEY,
  owner_name_ciphertext text NOT NULL,
  business_name_ciphertext text NOT NULL,
  email_hash text NOT NULL UNIQUE,
  email_ciphertext text NOT NULL,
  phone_hash text NOT NULL,
  phone_ciphertext text NOT NULL,
  website_ciphertext text,
  trade text NOT NULL,
  service_area_ciphertext text NOT NULL,
  desired_mode text NOT NULL,
  missed_calls_per_week integer,
  calendar_provider text NOT NULL,
  notes_ciphertext text,
  status text NOT NULL,
  source text NOT NULL,
  consented_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS pilot_signups_created_idx
  ON pilot_signups(created_at DESC);

COMMIT;
