BEGIN;

CREATE TABLE IF NOT EXISTS provider_routes (
  provider text NOT NULL,
  external_id text NOT NULL,
  tenant_id text NOT NULL REFERENCES business_configs(tenant_id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY(provider, external_id)
);

CREATE INDEX IF NOT EXISTS provider_routes_tenant_idx ON provider_routes(tenant_id);

COMMIT;
