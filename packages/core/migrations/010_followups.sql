-- Auto follow-up: when a customer goes quiet after the bot's reply, the bot nudges
-- them up to three times (each gap counted from the previous bot message), then
-- stops until the customer writes again.
ALTER TABLE messages DROP CONSTRAINT messages_origin_check;
ALTER TABLE messages ADD CONSTRAINT messages_origin_check
  CHECK (origin IN ('customer', 'keyword', 'flow', 'ai', 'human', 'system', 'followup'));

ALTER TABLE bot_settings ADD COLUMN followup_enabled boolean NOT NULL DEFAULT false;
-- Only chats whose last bot message came after the switch was turned on are followed up,
-- so turning it on does not nudge every old chat at once.
ALTER TABLE bot_settings ADD COLUMN followup_enabled_at timestamptz;
ALTER TABLE bot_settings ADD COLUMN followup_gaps_min integer[] NOT NULL DEFAULT '{60,180,600}'
  CHECK (cardinality(followup_gaps_min) BETWEEN 1 AND 3 AND 5 <= ALL (followup_gaps_min) AND 10080 >= ALL (followup_gaps_min));
ALTER TABLE bot_settings ADD COLUMN followup_start_hour integer NOT NULL DEFAULT 8 CHECK (followup_start_hour BETWEEN 0 AND 23);
ALTER TABLE bot_settings ADD COLUMN followup_end_hour integer NOT NULL DEFAULT 23 CHECK (followup_end_hour BETWEEN 1 AND 24);
ALTER TABLE bot_settings ADD COLUMN followup_instruction text NOT NULL DEFAULT
  'Pelbagaikan ayat setiap follow-up dan jangan ulang mesej sebelum ini. Ringkas, mesra, satu ajakan yang jelas, contohnya buat semakan percuma. Boleh sebut manfaat dan urgency secara sederhana, tetapi jangan dakwa stok terhad, promosi tamat atau harga naik kecuali maklumat itu ada. Jangan mendesak.'
  CHECK (char_length(followup_instruction) <= 2000);

-- Set when the AI judged that this chat should not be followed up (customer asked to be
-- contacted later, said no, or the chat had ended). Cleared in effect by the next inbound.
ALTER TABLE conversations ADD COLUMN followup_stopped_at timestamptz;
