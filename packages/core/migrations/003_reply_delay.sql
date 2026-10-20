-- Automated replies can wait a little before going out so they read like a person
-- typing. 0/0 = send immediately (the previous behaviour).
ALTER TABLE bot_settings
  ADD COLUMN reply_delay_min_ms int NOT NULL DEFAULT 0 CHECK (reply_delay_min_ms BETWEEN 0 AND 120000),
  ADD COLUMN reply_delay_max_ms int NOT NULL DEFAULT 0 CHECK (reply_delay_max_ms BETWEEN 0 AND 120000),
  ADD CONSTRAINT bot_settings_reply_delay_order CHECK (reply_delay_min_ms <= reply_delay_max_ms);
