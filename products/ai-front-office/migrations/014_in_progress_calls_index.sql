BEGIN;

-- The call-length guard polls every few seconds for calls still in progress (all shops). A partial index keeps
-- that scan to live calls only.
CREATE INDEX IF NOT EXISTS calls_in_progress_started_idx ON calls(started_at) WHERE outcome = 'in_progress';

COMMIT;
