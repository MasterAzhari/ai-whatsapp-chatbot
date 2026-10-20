-- Lead mode: the bot only serves chats that arrived through a lead keyword (for
-- example the pre-filled text of an ad). Other chats (team, friends, old customers)
-- get no automatic reply; staff answer them.
ALTER TABLE bot_settings ADD COLUMN lead_mode boolean NOT NULL DEFAULT false;
ALTER TABLE keyword_rules ADD COLUMN starts_lead boolean NOT NULL DEFAULT false;
ALTER TABLE conversations ADD COLUMN lead_started_at timestamptz;
