BEGIN;

CREATE TABLE IF NOT EXISTS owner_accounts (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL UNIQUE REFERENCES business_configs(tenant_id) ON DELETE CASCADE,
  email_hash text NOT NULL UNIQUE,
  email_ciphertext text NOT NULL,
  display_name_ciphertext text NOT NULL,
  password_hash text NOT NULL,
  status text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS owner_accounts_status_idx ON owner_accounts(status);

COMMIT;
