CREATE TABLE subscription_entitlements (
  credential_hash TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  subscription_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  stripe_event_created INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX subscription_entitlements_subscription_idx
  ON subscription_entitlements (subscription_id);

CREATE TABLE stripe_events (
  event_id TEXT PRIMARY KEY,
  processed_at INTEGER NOT NULL
);
