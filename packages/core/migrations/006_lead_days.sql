-- How long the bot serves a lead after its lead keyword arrived (0 = no limit).
ALTER TABLE bot_settings ADD COLUMN lead_days int NOT NULL DEFAULT 30 CHECK (lead_days BETWEEN 0 AND 365);
