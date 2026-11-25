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

-- When the owner proved they control the account email (Google, Microsoft, an email link or a reset link).
-- A password sign-up proves nothing, so it starts null; the first proof drops that password and its sessions,
-- so whoever typed someone else's email at sign-up can't keep a way in. Accounts made before sign-in by
-- Google, Microsoft or email link existed are counted as proved, so no current owner loses their password.
ALTER TABLE owner_accounts ADD COLUMN IF NOT EXISTS email_verified_at timestamptz;
UPDATE owner_accounts SET email_verified_at = created_at WHERE email_verified_at IS NULL;
COMMIT;
