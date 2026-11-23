BEGIN;

CREATE TABLE IF NOT EXISTS tenant_subscriptions (
  tenant_id text PRIMARY KEY REFERENCES business_configs(tenant_id) ON DELETE CASCADE,
  provider_customer_id text,
  provider_subscription_id text,
  status text NOT NULL,
  current_period_end timestamptz,
  provider_event_created_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS tenant_subscriptions_provider_id_idx
  ON tenant_subscriptions(provider_subscription_id)
  WHERE provider_subscription_id IS NOT NULL;

COMMIT;
