BEGIN;
-- Single-use "Email me a sign-in link" tokens. Only a hash of the token is stored. The email is
-- encrypted and kept because the address may have no account yet: the link then opens sign-up
-- with that email already confirmed.
CREATE TABLE IF NOT EXISTS owner_sign_in_tokens (
  token_hash text PRIMARY KEY,
  email_ciphertext text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS owner_sign_in_tokens_expires_idx ON owner_sign_in_tokens(expires_at);
COMMIT;
