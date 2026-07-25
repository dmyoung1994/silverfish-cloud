CREATE TABLE subscription_entitlements_new (
  credential_hash TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  subscription_id TEXT NOT NULL,
  status TEXT NOT NULL,
  email TEXT,
  stripe_event_created INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

INSERT INTO subscription_entitlements_new (
  credential_hash, customer_id, subscription_id, status, stripe_event_created, updated_at
)
SELECT credential_hash, customer_id, subscription_id, status, stripe_event_created, updated_at
FROM subscription_entitlements;

DROP TABLE subscription_entitlements;
ALTER TABLE subscription_entitlements_new RENAME TO subscription_entitlements;

CREATE INDEX subscription_entitlements_subscription_idx
  ON subscription_entitlements (subscription_id);

CREATE INDEX subscription_entitlements_email_idx
  ON subscription_entitlements (email);
