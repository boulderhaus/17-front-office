BEGIN;

-- Call recovery polls every few seconds for calls that never got an end-of-call payload (all shops), so it can
-- rebuild them from the provider's conversation history. A partial index keeps that scan to unfinished calls only.
CREATE INDEX IF NOT EXISTS calls_unfinished_started_idx ON calls(started_at) WHERE ended_at IS NULL;

COMMIT;
