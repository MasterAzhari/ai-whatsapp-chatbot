-- Phase 2: bot settings, keyword rules, routing jobs, AI usage and pricing.

CREATE TABLE bot_settings (
  tenant_id          uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  version            int NOT NULL DEFAULT 1,           -- bumped on every change; used for edit-conflict checks
  persona_name       text NOT NULL DEFAULT 'Assistant',
  language           text NOT NULL DEFAULT 'ms',
  system_instruction text NOT NULL DEFAULT '',
  ai_enabled         boolean NOT NULL DEFAULT false,   -- tenant-level AI switch (channel and conversation switches also apply)
  ai_provider        text NOT NULL DEFAULT 'gemini' CHECK (ai_provider IN ('gemini')),
  ai_model           text,                             -- chosen in the UI; never hardcoded
  max_output_tokens  int NOT NULL DEFAULT 400 CHECK (max_output_tokens BETWEEN 16 AND 8192),
  temperature        numeric(3,2) CHECK (temperature IS NULL OR temperature BETWEEN 0 AND 2),
  history_turns      int NOT NULL DEFAULT 10 CHECK (history_turns BETWEEN 1 AND 50),
  ai_timeout_ms      int NOT NULL DEFAULT 20000 CHECK (ai_timeout_ms BETWEEN 1000 AND 120000),
  fallback_reply     text,                             -- sent when AI fails; null = hand over to a human instead
  handover_reply     text,                             -- sent when the customer asks for a human
  stop_keywords      text[] NOT NULL DEFAULT ARRAY['stop', 'berhenti', 'unsubscribe'],
  human_keywords     text[] NOT NULL DEFAULT ARRAY['nak cakap dengan orang', 'agent', 'customer service', 'admin'],
  updated_by         uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE keyword_rules (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  channel_id    uuid,                                  -- null = all channels of the tenant
  name          text NOT NULL,
  match_type    text NOT NULL CHECK (match_type IN ('exact', 'phrase')),
  patterns      text[] NOT NULL CHECK (cardinality(patterns) BETWEEN 1 AND 50),
  priority      int NOT NULL DEFAULT 100,              -- lower runs first
  enabled       boolean NOT NULL DEFAULT true,
  reply_text    text,
  set_label     text,
  handover      boolean NOT NULL DEFAULT false,
  cooldown_seconds int NOT NULL DEFAULT 0 CHECK (cooldown_seconds >= 0),
  version       int NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (reply_text IS NOT NULL OR set_label IS NOT NULL OR handover),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, channel_id) REFERENCES channels(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX keyword_rules_tenant_idx ON keyword_rules (tenant_id, priority) WHERE enabled;

CREATE TABLE keyword_rule_hits (
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL,
  rule_id         uuid NOT NULL,
  last_hit_at     timestamptz NOT NULL,
  PRIMARY KEY (conversation_id, rule_id),
  FOREIGN KEY (tenant_id, conversation_id) REFERENCES conversations(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, rule_id) REFERENCES keyword_rules(tenant_id, id) ON DELETE CASCADE
);

-- Why each inbound message was (or was not) answered: shown in the inbox and playground.
ALTER TABLE messages ADD COLUMN route jsonb;

CREATE TABLE ai_usage_events (
  id              bigserial PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  conversation_id uuid,
  provider        text NOT NULL,
  model           text NOT NULL,
  input_tokens    int,                                 -- null = provider did not report it
  output_tokens   int,
  latency_ms      int,
  outcome         text NOT NULL,                        -- ok | timeout | quota | invalid_model | blocked | error | aborted
  source          text NOT NULL DEFAULT 'live' CHECK (source IN ('live', 'playground')),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_usage_events_tenant_idx ON ai_usage_events (tenant_id, created_at DESC);

-- Editable rate card. Costs are shown as estimates only where a rate exists here.
CREATE TABLE pricing_rates (
  id                 bigserial PRIMARY KEY,
  provider           text NOT NULL,
  model              text NOT NULL,
  currency           text NOT NULL DEFAULT 'USD',
  input_per_million  numeric(12,6) NOT NULL,
  output_per_million numeric(12,6) NOT NULL,
  effective_from     date NOT NULL,
  source_url         text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, model, effective_from)
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['bot_settings', 'keyword_rules', 'keyword_rule_hits', 'ai_usage_events'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (app_tenant_visible(tenant_id)) WITH CHECK (app_tenant_visible(tenant_id))', t);
  END LOOP;
END $$;
-- pricing_rates is platform data (no tenant): readable by all, written only by system code.
ALTER TABLE pricing_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE pricing_rates FORCE ROW LEVEL SECURITY;
CREATE POLICY read_all ON pricing_rates FOR SELECT USING (true);
CREATE POLICY system_write ON pricing_rates FOR ALL
  USING (coalesce(current_setting('app.system', true), '') = 'on')
  WITH CHECK (coalesce(current_setting('app.system', true), '') = 'on');
