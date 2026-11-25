BEGIN;

-- Call Otto's own secrets, not any shop's (Store tenant "platform"): the AI setup helper's assistant id and the
-- founder's connected Google calendars (refresh tokens, which account takes bookings, booked setup calls).
-- integration_secrets requires a shop row (foreign key to business_configs), so these live here. Values are
-- encrypted by the app exactly like integration_secrets.
CREATE TABLE IF NOT EXISTS platform_secrets (
  provider text NOT NULL,
  secret_key text NOT NULL,
  value_ciphertext text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(provider, secret_key)
);

COMMIT;
