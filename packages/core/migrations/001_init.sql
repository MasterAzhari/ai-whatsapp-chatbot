-- Phase 1 schema: tenancy, auth, channels, contacts, conversations, messages,
-- durable outbox and jobs, audit. All business data carries tenant_id and is
-- protected by row-level security (see bottom of file). Requires PostgreSQL 13+
-- (gen_random_uuid is built in).

-- ---------------------------------------------------------------- tenancy

CREATE TABLE tenants (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  name        text NOT NULL,
  timezone    text NOT NULL DEFAULT 'Asia/Kuala_Lumpur',
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email          text NOT NULL,
  name           text NOT NULL,
  password_hash  text NOT NULL,
  is_platform_owner boolean NOT NULL DEFAULT false,
  disabled_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_key ON users (lower(email));

CREATE TABLE tenant_memberships (
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        text NOT NULL CHECK (role IN ('admin', 'operator')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id)
);

CREATE TABLE sessions (
  id_hash     text PRIMARY KEY,          -- sha256 of the cookie token; token itself is never stored
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  user_agent  text
);
CREATE INDEX sessions_user_idx ON sessions (user_id);

-- ---------------------------------------------------------------- channels

CREATE TABLE channels (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name            text NOT NULL,
  provider        text NOT NULL CHECK (provider IN ('official', 'qr', 'mock')),
  status          text NOT NULL DEFAULT 'disconnected'
                  CHECK (status IN ('disconnected', 'pairing', 'connected', 'error')),
  status_reason   text,
  display_number  text,                    -- verified number as reported by provider, never guessed
  last_connected_at timestamptz,
  automation_enabled boolean NOT NULL DEFAULT false,  -- production outbound starts disabled
  ai_enabled      boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);

-- Secrets live encrypted in credential_references; only ciphertext is stored.
CREATE TABLE credential_references (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind        text NOT NULL,              -- e.g. gemini_api_key, wa_official_token
  ciphertext  text NOT NULL,              -- AES-256-GCM, key from APP_ENCRYPTION_KEY (outside DB)
  created_at  timestamptz NOT NULL DEFAULT now(),
  rotated_at  timestamptz,
  UNIQUE (tenant_id, kind)
);

-- ---------------------------------------------------------------- contacts

CREATE TABLE contacts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  display_name  text,
  phone_e164    text CHECK (phone_e164 IS NULL OR phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  notes         text,
  custom_fields jsonb NOT NULL DEFAULT '{}'::jsonb,
  opted_out_at  timestamptz,               -- global messaging opt-out
  last_inbound_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);

-- Provider identities (wa_id, LID, etc.) are not assumed to be phone numbers.
CREATE TABLE provider_identity_mappings (
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  channel_id    uuid NOT NULL,
  provider_identity text NOT NULL,
  contact_id    uuid NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (channel_id, provider_identity),
  FOREIGN KEY (tenant_id, channel_id) REFERENCES channels(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, contact_id) REFERENCES contacts(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE contact_labels (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        text NOT NULL,
  color       text,
  UNIQUE (tenant_id, name),
  UNIQUE (tenant_id, id)
);

CREATE TABLE contact_label_assignments (
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  contact_id  uuid NOT NULL,
  label_id    uuid NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (contact_id, label_id),
  FOREIGN KEY (tenant_id, contact_id) REFERENCES contacts(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, label_id) REFERENCES contact_labels(tenant_id, id) ON DELETE CASCADE
);

-- ---------------------------------------------------------------- conversations

CREATE TABLE conversations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  channel_id    uuid NOT NULL,
  contact_id    uuid NOT NULL,
  status        text NOT NULL DEFAULT 'open'
                CHECK (status IN ('open', 'pending_human', 'resolved')),
  human_takeover boolean NOT NULL DEFAULT false,
  ai_enabled    boolean,                   -- null = inherit from channel
  assignee_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  last_message_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, channel_id) REFERENCES channels(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, contact_id) REFERENCES contacts(tenant_id, id) ON DELETE CASCADE
);
-- One active conversation thread per contact per channel.
CREATE UNIQUE INDEX conversations_channel_contact_key ON conversations (channel_id, contact_id);
CREATE INDEX conversations_inbox_idx ON conversations (tenant_id, status, last_message_at DESC);

CREATE TABLE messages (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL,
  channel_id    uuid NOT NULL,
  direction     text NOT NULL CHECK (direction IN ('inbound', 'outbound', 'note')),
  origin        text NOT NULL CHECK (origin IN ('customer', 'keyword', 'flow', 'ai', 'human', 'system')),
  body          text,
  attachments   jsonb NOT NULL DEFAULT '[]'::jsonb,
  provider_message_id text,
  status        text NOT NULL DEFAULT 'received'
                CHECK (status IN ('received', 'queued', 'accepted', 'sent', 'delivered', 'read', 'failed', 'unknown')),
  status_detail text,
  author_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  provider_timestamp timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, conversation_id) REFERENCES conversations(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, channel_id) REFERENCES channels(tenant_id, id) ON DELETE CASCADE
);
-- Dedup: a provider message id is unique per channel (not globally).
CREATE UNIQUE INDEX messages_provider_id_key ON messages (channel_id, provider_message_id)
  WHERE provider_message_id IS NOT NULL;
CREATE INDEX messages_conversation_idx ON messages (conversation_id, created_at);

CREATE TABLE delivery_events (
  id            bigserial PRIMARY KEY,
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  channel_id    uuid NOT NULL,
  provider_message_id text NOT NULL,
  status        text NOT NULL,
  detail        text,
  provider_timestamp timestamptz,
  received_at   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, channel_id) REFERENCES channels(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX delivery_events_msg_idx ON delivery_events (channel_id, provider_message_id);

-- ---------------------------------------------------------------- durable outbox and jobs

CREATE TABLE outbox (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  channel_id      uuid NOT NULL,
  conversation_id uuid NOT NULL,
  message_id      uuid NOT NULL,
  idempotency_key text NOT NULL,
  state           text NOT NULL DEFAULT 'pending'
                  CHECK (state IN ('pending', 'sending', 'sent', 'failed', 'unknown', 'cancelled')),
  attempts        int NOT NULL DEFAULT 0,
  max_attempts    int NOT NULL DEFAULT 5,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_until     timestamptz,
  expires_at      timestamptz,             -- do not send stale backlog after reconnect
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, message_id) REFERENCES messages(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, channel_id) REFERENCES channels(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX outbox_due_idx ON outbox (next_attempt_at) WHERE state = 'pending';

CREATE TABLE scheduled_jobs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind          text NOT NULL,
  dedupe_key    text NOT NULL,
  payload       jsonb NOT NULL DEFAULT '{}'::jsonb,
  run_at        timestamptz NOT NULL,
  state         text NOT NULL DEFAULT 'pending'
                CHECK (state IN ('pending', 'running', 'done', 'skipped', 'failed', 'cancelled')),
  attempts      int NOT NULL DEFAULT 0,
  lease_until   timestamptz,
  result        text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, kind, dedupe_key)
);
CREATE INDEX scheduled_jobs_due_idx ON scheduled_jobs (run_at) WHERE state = 'pending';

-- ---------------------------------------------------------------- audit

CREATE TABLE audit_events (
  id          bigserial PRIMARY KEY,
  tenant_id   uuid REFERENCES tenants(id) ON DELETE CASCADE,  -- null = platform-level event
  actor_type  text NOT NULL CHECK (actor_type IN ('user', 'integration', 'system')),
  actor_id    text,
  action      text NOT NULL,
  target_type text,
  target_id   text,
  before      jsonb,
  after       jsonb,
  source      text NOT NULL DEFAULT 'web' CHECK (source IN ('web', 'mcp', 'api', 'system')),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_events_tenant_idx ON audit_events (tenant_id, created_at DESC);

-- ---------------------------------------------------------------- row-level security
-- Every request sets app.tenant_id inside its transaction (see db.ts withTenant).
-- System paths that must cross tenants (worker claiming due jobs, login) set
-- app.system = 'on' explicitly. FORCE makes the policies apply to the table owner too,
-- so the application role must not be a superuser (superusers always bypass RLS).

CREATE FUNCTION app_tenant_visible(t uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT coalesce(current_setting('app.system', true), '') = 'on'
      OR t::text = coalesce(nullif(current_setting('app.tenant_id', true), ''), '00000000-0000-0000-0000-000000000000')
$$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'tenant_memberships', 'channels', 'credential_references', 'contacts',
    'provider_identity_mappings', 'contact_labels', 'contact_label_assignments',
    'conversations', 'messages', 'delivery_events', 'outbox', 'scheduled_jobs'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (app_tenant_visible(tenant_id)) WITH CHECK (app_tenant_visible(tenant_id))', t);
  END LOOP;
END $$;

ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenants USING (app_tenant_visible(id)) WITH CHECK (app_tenant_visible(id));

ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON audit_events
  USING (app_tenant_visible(tenant_id) OR (tenant_id IS NULL AND coalesce(current_setting('app.system', true), '') = 'on'))
  WITH CHECK (app_tenant_visible(tenant_id) OR (tenant_id IS NULL AND coalesce(current_setting('app.system', true), '') = 'on'));
