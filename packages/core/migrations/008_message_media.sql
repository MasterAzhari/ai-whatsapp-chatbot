-- A customer's voice note or picture, kept only until the bot has turned it into text
-- (the router deletes it right after routing the message).
CREATE TABLE message_media (
  message_id  uuid PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('audio', 'image')),
  mime_type   text NOT NULL,
  data        bytea NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE message_media ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_media FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON message_media USING (app_tenant_visible(tenant_id)) WITH CHECK (app_tenant_visible(tenant_id));
