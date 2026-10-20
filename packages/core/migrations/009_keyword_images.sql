-- Pictures (posters, product photos) a keyword reply sends with its text.
CREATE TABLE media_assets (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  mime_type   text NOT NULL CHECK (mime_type IN ('image/jpeg', 'image/png', 'image/webp')),
  bytes       int NOT NULL CHECK (bytes BETWEEN 1 AND 5242880),
  data        bytea NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE media_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE media_assets FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON media_assets USING (app_tenant_visible(tenant_id)) WITH CHECK (app_tenant_visible(tenant_id));

ALTER TABLE keyword_rules ADD COLUMN image_asset_id uuid REFERENCES media_assets(id) ON DELETE SET NULL;
ALTER TABLE messages ADD COLUMN image_asset_id uuid REFERENCES media_assets(id) ON DELETE SET NULL;
-- A rule may now do nothing but send its picture.
ALTER TABLE keyword_rules DROP CONSTRAINT keyword_rules_check;
ALTER TABLE keyword_rules ADD CONSTRAINT keyword_rules_check CHECK (reply_text IS NOT NULL OR set_label IS NOT NULL OR handover OR image_asset_id IS NOT NULL);
