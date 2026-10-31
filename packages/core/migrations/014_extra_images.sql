-- A keyword reply can show a product from several angles: up to 3 more pictures,
-- sent one after another right after the first bubble (which carries image_asset_id).
ALTER TABLE keyword_rules ADD COLUMN extra_image_ids uuid[] NOT NULL DEFAULT '{}'
  CHECK (cardinality(extra_image_ids) <= 3);
