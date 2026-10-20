# Decisions and assumptions

Choices made while building that the spec left open. Owner decisions are marked
**Owner**; everything else is an implementation choice that can be revisited.

| # | Date | Decision | Why |
|---|------|----------|-----|
| 1 | 2026-10-19 | **Owner:** deploy on the existing Hostinger KVM 2 VPS (pibot.io) beside Typebot, instead of a new KVM 1. | Capacity check: ~5.7 GB RAM free, CPU idle. |
| 2 | 2026-10-19 | **Owner:** do not use n8n for the chatbot; WAHA was removed from the VPS. Build our own gateway, website and API. | Owner instruction. |
| 3 | 2026-10-20 | **Owner:** code lives in its own private repo `ai-whatsapp-chatbot`. | Keep separate from other projects; product is for sale. |
| 4 | 2026-10-20 | Tenant isolation enforced by PostgreSQL row-level security (`FORCE ROW LEVEL SECURITY`), with `app.tenant_id` set per transaction. The app refuses to run as a superuser / BYPASSRLS role. | Spec requires isolation in queries, jobs and credentials, not just UI filtering. A missed `WHERE tenant_id` cannot leak data. |
| 5 | 2026-10-20 | On pibot.io, use a separate database and non-superuser role inside the existing `typebot-db` Postgres rather than a third Postgres container. | Saves RAM; Typebot data untouched. Spec's 3-container layout remains the standalone default. |
| 6 | 2026-10-20 | Durable outbox with leases and `SKIP LOCKED`; a send whose worker died mid-flight is marked `unknown`, never blindly resent. | Spec: no exactly-once claims, no blind retries after timeouts. |
| 7 | 2026-10-20 | Automated replies expire (default 15 min), human replies after 24 h; expired items are cancelled, not sent. | Spec: do not flush stale backlog after reconnect. |
| 8 | 2026-10-20 | Sending a manual reply turns on human takeover and cancels queued automated replies. Resume is an explicit button. | Spec: takeover pauses automation; resume must be explicit. |
| 9 | 2026-10-20 | New channels start with automation and AI **off**. | Spec: production outbound starts disabled until acceptance. |
| 10 | 2026-10-20 | Stack: Node 22, TypeScript, Next.js 15.5 (App Router, server actions), `pg` with plain SQL migrations, zod. No ORM. | Small dependency surface for a product that will be resold; SQL needed for RLS anyway. |
| 11 | 2026-10-20 | Sessions: random 256-bit token in an httpOnly cookie, only its SHA-256 stored. Passwords: scrypt. | Standard, no extra dependency. |
| 12 | 2026-10-20 | Provider credentials encrypted with AES-256-GCM using `APP_ENCRYPTION_KEY` held outside the DB. | Spec: credentials encrypted, master key outside DB and backups. |
| 13 | 2026-10-20 | UI language Bahasa Melayu for now; to become configurable per tenant. | Owner's working language. |

## Open (not decided; do not invent)

Product name, sales model (shared SaaS vs dedicated), plans and pricing, real
WhatsApp test number, Gemini key and model, Meta assets, follow-up schedule, MCP
client and its auth mechanism, QR library (Baileys is the first candidate; licence
and stability still to be evaluated).
