BEGIN;

-- Voice tool budgets and write claims, shared by every replica and kept across restarts.
-- A phone call lasts minutes, so the retention loop drops rows untouched for two hours.
CREATE TABLE IF NOT EXISTS tool_call_budgets (
  provider_call_id text NOT NULL,
  tool text NOT NULL,
  call_count integer NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (provider_call_id, tool)
);
CREATE INDEX IF NOT EXISTS tool_call_budgets_updated_at_idx ON tool_call_budgets(updated_at);

-- Idempotency for book_slot and save_intake. A row is claimed (result NULL) before the side effect, so only
-- one worker writes; a late or repeated call gets the stored result. Results hold statuses and instructions
-- only, never caller details.
CREATE TABLE IF NOT EXISTS tool_results (
  provider_call_id text NOT NULL,
  idempotency_key text NOT NULL,
  result jsonb,
  claimed_at timestamptz NOT NULL,
  completed_at timestamptz,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (provider_call_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS tool_results_created_at_idx ON tool_results(created_at);

COMMIT;
