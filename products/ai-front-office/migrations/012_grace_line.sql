BEGIN;

-- Billing grace line: find a shop by the Front Office number a caller dialed, without decrypting every secret.
ALTER TABLE integration_secrets ADD COLUMN IF NOT EXISTS lookup_hash text;
CREATE INDEX IF NOT EXISTS integration_secrets_lookup_idx
  ON integration_secrets(provider, secret_key, lookup_hash) WHERE lookup_hash IS NOT NULL;

COMMIT;
