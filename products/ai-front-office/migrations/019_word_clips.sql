BEGIN;

-- Settings > Names and words, "Say it" (walk 11-26, SET-05): the owner's own short recording of one word.
-- One clip per shop and word (term_key: lower case, single spaces). The audio is encrypted by the app like
-- integration_secrets. Deleting the shop (business_configs row) deletes its clips.
CREATE TABLE IF NOT EXISTS word_clips (
  tenant_id text NOT NULL REFERENCES business_configs(tenant_id) ON DELETE CASCADE,
  term_key text NOT NULL,
  term text NOT NULL,
  mime_type text NOT NULL,
  audio_ciphertext text NOT NULL,
  heard text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id, term_key)
);

COMMIT;
