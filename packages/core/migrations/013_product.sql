-- One WhatsApp number can sell several products (e.g. aircond and a fridge). A keyword
-- rule can belong to a product; a chat remembers the product of the last product rule
-- it hit (usually its lead keyword), and then only that product's rules (and rules with
-- no product) answer it.
ALTER TABLE keyword_rules ADD COLUMN product text CHECK (product IS NULL OR length(product) BETWEEN 1 AND 60);
ALTER TABLE conversations ADD COLUMN product text;
