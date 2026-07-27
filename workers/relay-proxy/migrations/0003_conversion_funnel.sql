CREATE TABLE conversion_campaigns (
  campaign_hash TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  credential_hash TEXT,
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  activated_at INTEGER
);

CREATE INDEX conversion_campaigns_credential_idx
  ON conversion_campaigns (credential_hash);

CREATE INDEX conversion_campaigns_expiry_idx
  ON conversion_campaigns (expires_at);

CREATE TABLE conversion_events (
  campaign_hash TEXT NOT NULL REFERENCES conversion_campaigns(campaign_hash),
  event_type TEXT NOT NULL,
  occurred_at INTEGER NOT NULL,
  PRIMARY KEY (campaign_hash, event_type)
);
