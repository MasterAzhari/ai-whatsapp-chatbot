-- What the bot says when a lead sends only a voice note, picture, video or file (no text).
-- NULL = send nothing; the chat is still marked as needing staff.
ALTER TABLE bot_settings ADD COLUMN media_reply text
  DEFAULT 'Maaf, saya belum dapat dengar voice note atau lihat gambar dan video. Boleh taip soalan anda? Team kami juga akan semak mesej ini.'
  CHECK (char_length(media_reply) <= 1000);
