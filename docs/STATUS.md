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
| Docker images + compose (pibot) | Done | Built and running on the VPS 2026-10-20; standalone compose not yet run |
| Deployment to pibot.io | Done (mock WhatsApp) | https://bot.pibot.io/api/health ok; existing services unaffected |

Test run 2026-10-20 (Phase 1): core 21/21, gateway 3/3.

## Phase 2: chatbot core

| Item | State | Evidence |
|------|-------|----------|
| Schema: bot settings, keyword rules, rule hits, route reason, AI usage, pricing rates (RLS on tenant tables) | Done | `packages/core/migrations/002_routing.sql`; isolation tests |
| Routing order: switches/takeover → stop → ask-for-human → keyword → AI | Done | `decide` tests |
| Keyword engine: exact / whole-word phrase, priority, channel scope, cooldown, label, handover | Done | matcher + routing tests |
| Routing jobs: inbound stored and routing job queued in one transaction; worker routes, one decision per message | Done | test: routing twice queues one reply |
| Gemini adapter (direct REST, key in header only), model list from the API | Mock only | tests with mocked fetch; not yet called with a real key |
| AI safety: guardrails appended, reply discarded if takeover/opt-out/newer message during generation, fallback or handover on failure | Done | routing tests |
| AI usage: tokens as reported (null when not reported), estimated cost only where a rate exists | Done | usage tests; dashboard table |
| API key stored encrypted, shown masked, never audited | Done | test |
| Website: Keyword, Tetapan bot (key, model picker, switches), Playground (dry run + test customer on MOCK channel), route reason in conversation | Done | Playwright walkthrough: rule created, playground match, mock customer got keyword reply via worker |
| Internal webhook for gateway events (`/api/internal/gateway/events`, GATEWAY_TOKEN) | Done | builds; used once the QR driver lands |
| QR driver in the gateway | Not started | library evaluation first; needs a test number |
| Flow state, knowledge snippets | Not started | |

Test run 2026-10-20 (Phase 2): core 47/47, gateway 3/3.

## Next

QR driver (library evaluation), flow state, knowledge. Then Phase 3: official
Cloud API adapter and authenticated MCP.

## Needs from the owner (only when we reach that step)

- A WhatsApp **test** number for QR pairing.
- A Gemini API key (from Google AI Studio), entered in Tetapan bot (never in chat).
- Go-ahead before each deploy to `bot.pibot.io`.
