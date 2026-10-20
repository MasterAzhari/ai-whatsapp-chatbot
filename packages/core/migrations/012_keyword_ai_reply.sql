-- A keyword can hand the message to the AI instead of a fixed reply, e.g. a filled-in
-- form the AI must check (missing postcode, same phone for customer and next of kin).
ALTER TABLE keyword_rules ADD COLUMN ai_reply boolean NOT NULL DEFAULT false;
ALTER TABLE keyword_rules DROP CONSTRAINT keyword_rules_check;
ALTER TABLE keyword_rules ADD CONSTRAINT keyword_rules_check
  CHECK (reply_text IS NOT NULL OR set_label IS NOT NULL OR handover OR image_asset_id IS NOT NULL OR ai_reply);
