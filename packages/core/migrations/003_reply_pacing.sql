-- Reply pacing: wait a little and show "typing…" before automated replies, so the
-- bot does not answer instantly. Applies to keyword, AI and system replies only.
ALTER TABLE bot_settings
  ADD COLUMN reply_delay_min_sec int NOT NULL DEFAULT 3 CHECK (reply_delay_min_sec BETWEEN 0 AND 120),
  ADD COLUMN reply_delay_max_sec int NOT NULL DEFAULT 8 CHECK (reply_delay_max_sec BETWEEN 0 AND 120),
  ADD COLUMN typing_indicator boolean NOT NULL DEFAULT true,
  ADD CONSTRAINT reply_delay_range CHECK (reply_delay_max_sec >= reply_delay_min_sec);
