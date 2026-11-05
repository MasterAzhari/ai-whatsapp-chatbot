-- Staff can send pictures, videos and documents from the Inbox, not only keyword pictures.
ALTER TABLE media_assets DROP CONSTRAINT media_assets_mime_type_check;
ALTER TABLE media_assets ADD CONSTRAINT media_assets_mime_type_check CHECK (mime_type IN (
  'image/jpeg', 'image/png', 'image/webp',
  'video/mp4', 'video/3gpp',
  'application/pdf', 'text/plain',
  'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
));
ALTER TABLE media_assets DROP CONSTRAINT media_assets_bytes_check;
ALTER TABLE media_assets ADD CONSTRAINT media_assets_bytes_check CHECK (bytes BETWEEN 1 AND 10485760);
-- The name a document is sent and downloaded with.
ALTER TABLE media_assets ADD COLUMN file_name text CHECK (file_name IS NULL OR length(file_name) BETWEEN 1 AND 200);
