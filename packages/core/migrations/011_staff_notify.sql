-- Staff WhatsApp numbers the bot alerts when a chat needs a person (handover, form
-- sent back, AI failed). Kept out of bot templates: each workspace has its own staff.
ALTER TABLE bot_settings ADD COLUMN notify_numbers text[] NOT NULL DEFAULT '{}'
  CHECK (cardinality(notify_numbers) <= 3);
