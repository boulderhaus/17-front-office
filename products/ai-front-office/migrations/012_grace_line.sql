BEGIN;

-- Billing grace line: find a shop by the Front Office number a caller dialed, without decrypting every secret.
-- The keyed hash is computed by the app (it needs DATA_ENCRYPTION_KEY); rows saved before this migration are
-- backfilled at startup. One number belongs to one shop, so the index is unique.
ALTER TABLE integration_secrets ADD COLUMN IF NOT EXISTS lookup_hash text;
CREATE UNIQUE INDEX IF NOT EXISTS integration_secrets_inbound_number_lookup_idx
  ON integration_secrets(lookup_hash) WHERE provider = 'telnyx' AND secret_key = 'inbound_number' AND lookup_hash IS NOT NULL;

COMMIT;
