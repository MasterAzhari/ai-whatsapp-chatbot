-- Claude (Anthropic) as a second AI provider, chosen per tenant in Tetapan bot.
-- Its key is stored like the Gemini key: encrypted in credential_references (kind anthropic_api_key).
ALTER TABLE bot_settings DROP CONSTRAINT bot_settings_ai_provider_check;
ALTER TABLE bot_settings ADD CONSTRAINT bot_settings_ai_provider_check CHECK (ai_provider IN ('gemini', 'anthropic'));

-- Published Claude API list prices (USD per 1M tokens, prompts up to 100K tokens for Haiku).
SELECT set_config('app.system', 'on', true);
INSERT INTO pricing_rates (provider, model, input_per_million, output_per_million, effective_from, source_url) VALUES
  ('anthropic', 'claude-haiku-5-5', 0.10, 0.50, '2026-10-01', 'https://claude.com/pricing'),
  ('anthropic', 'claude-sonnet-5-5', 2.00, 10.00, '2026-10-01', 'https://claude.com/pricing'),
  ('anthropic', 'claude-opus-5-5', 4.00, 20.00, '2026-10-01', 'https://claude.com/pricing')
ON CONFLICT DO NOTHING;
