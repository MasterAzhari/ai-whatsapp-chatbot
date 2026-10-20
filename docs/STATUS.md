# Status

Legend: **Done** (built and tested), **Mock only** (works against mock adapters,
not proven live), **Not started**.

## Phase 1: foundation

| Item | State | Evidence |
|------|-------|----------|
| Repo, workspaces, TypeScript build | Done | `npm run build` |
| Schema + migrations (tenants, users, memberships, sessions, channels, credentials, contacts, identity mappings, labels, conversations, messages, delivery events, outbox, jobs, audit) | Done | `packages/core/migrations/001_init.sql` |
| Tenant isolation via row-level security | Done | tests: A cannot read, write or act on B's rows; nothing visible without a tenant |
| Auth (scrypt, sessions), roles (platform owner, admin, operator) | Done | tests: wrong password, no access to other workspace |
| Inbound ingest: dedupe, ignore own/group/history, identity mapping | Done | tests: repeated and concurrent duplicate webhooks store once |
| Delivery status ordering | Done | test: `read` is not overwritten by a late `delivered` |
| Durable outbox + worker (leases, backoff, unknown state, expiry, eligibility re-check before send) | Done | tests: retry, unknown not retried, crash mid-send, stale backlog, takeover after claim |
| Human takeover / resume, manual reply, internal notes | Done | tests + browser walkthrough |
| Website: login, workspace picker, dashboard, inbox, conversation, connections | Done | Playwright walkthrough against local build |
| whatsapp-gateway service with internal token auth | Mock only | gateway tests; no real WhatsApp session |
| AI provider contract | Mock only | Gemini adapter is Phase 2 |
| Docker images + compose (standalone and pibot) | Written, **not built here** | No Docker daemon in the build environment; app supervisor tested locally (start, health, clean SIGTERM) |
| Deployment to pibot.io | Not started | Needs owner go-ahead |

Test run 2026-10-20: core 21/21, gateway 3/3.

## Next: Phase 2 (chatbot core)

QR driver in the gateway (library evaluation first), keyword rules, flow state,
Gemini adapter with usage tracking, knowledge, AI/automation switches in the UI,
playground. Then Phase 3: official Cloud API adapter and authenticated MCP.

## Needs from the owner (only when we reach that step)

- A WhatsApp **test** number for QR pairing.
- A Gemini API key (from Google AI Studio) for testing.
- Go-ahead before the first deploy to `bot.pibot.io`.
