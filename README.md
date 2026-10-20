# AI WhatsApp Chatbot

Multi-tenant platform for running WhatsApp chatbots: a website for inbox and bot
management, WhatsApp adapters (official Cloud API and unofficial QR), keyword and
flow rules before AI, Gemini as the first AI provider, and an MCP endpoint so the
bot can be configured by instruction. Built to be resold, so nothing is hardcoded
to one business, number, model or secret.

The full specification is `docs/SPEC-handoff-2026-10-20.txt`. Current progress is in
[`docs/STATUS.md`](docs/STATUS.md); decisions beyond the spec are in
[`docs/DECISIONS.md`](docs/DECISIONS.md).

> **Status: Phase 1 (foundation).** Everything runs against MOCK WhatsApp and AI
> adapters with synthetic data. Nothing here sends to real WhatsApp yet.

## Layout

```
packages/core     domain logic: schema + migrations, tenancy (row-level security),
                  auth, inbound ingest, durable outbox, worker, adapter contracts
apps/web          Next.js website + API (login, dashboard, inbox, connections)
apps/gateway      whatsapp-gateway service (QR sessions; mock driver for now)
docker/           Dockerfiles, app supervisor, postgres init
deploy/pibot/     deployment beside the existing services on the pibot.io VPS
```

Three containers: `app` (website, API and worker, supervised together),
`whatsapp-gateway`, `postgres`. No n8n, Redis or vector database.

## Run locally

Needs Node 22 and PostgreSQL 13+.

```sh
npm ci
# A NON-superuser role: superusers bypass row-level security (the tenant boundary).
psql -U postgres -c "CREATE ROLE chatbot LOGIN PASSWORD 'devpass' NOSUPERUSER NOBYPASSRLS" \
                 -c "CREATE DATABASE chatbot OWNER chatbot"
export DATABASE_URL=postgres://chatbot:devpass@127.0.0.1:5432/chatbot

npm run build -w @chatbot/core
npm run migrate
SEED_ADMIN_EMAIL=you@example.com SEED_ADMIN_PASSWORD='at-least-10-chars' npm run seed
npm run worker &          # outbox worker
npm run dev               # http://localhost:3000
```

The seed creates two synthetic workspaces (`demo-khind`, `demo-tenant-b`) on mock
channels so tenant separation can be checked in the UI.

## Run with Docker Compose

```sh
cp .env.example .env      # fill in every value
docker compose up -d --build
docker compose exec app node packages/core/dist/src/cli/seed.js   # optional demo data
```

The app listens on `127.0.0.1:3000`; put a TLS reverse proxy in front. For the
pibot.io VPS see [`docs/DEPLOY.md`](docs/DEPLOY.md).

## Tests

```sh
npm test    # core (needs a local Postgres superuser to create throwaway DBs) + gateway
```

`TEST_ADMIN_URL` overrides the admin connection (default
`postgres://postgres@127.0.0.1:5432/postgres`). Each run creates a throwaway database
owned by a non-superuser role, so row-level security is really exercised.
