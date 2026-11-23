BEGIN;
ALTER TABLE owner_accounts ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'owner' CHECK (role IN ('owner','member'));
ALTER TABLE owner_accounts DROP CONSTRAINT IF EXISTS owner_accounts_tenant_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS owner_accounts_one_owner_idx ON owner_accounts(tenant_id) WHERE role='owner';
CREATE INDEX IF NOT EXISTS owner_accounts_tenant_idx ON owner_accounts(tenant_id);
COMMIT;
