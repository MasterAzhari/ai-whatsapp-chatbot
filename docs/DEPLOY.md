# Deploying on the pibot.io VPS

The VPS (Hostinger KVM 2, Ubuntu 22.04) already runs, from `/root/docker-compose.yml`:
caddy-gen (ports 80/443, routes by the `virtual.host` label), Typebot, its Postgres
`typebot-db`, MinIO and n8n, all on the Docker network `root_default`. ufw allows
only 22, 80 and 443.

The chatbot runs as a **separate compose project** so the existing file is never edited.

## First deploy

1. DNS: `bot.pibot.io` already resolves to the VPS.
2. Copy the repo to `/opt/chatbot` and create `/opt/chatbot/.env` from `.env.example`
   (chmod 600). Generate every secret with `openssl rand -base64 32`. Keep
   `APP_ENCRYPTION_KEY` somewhere off the server as well.
3. Check the label names caddy-gen expects by comparing with an existing service:
   `docker inspect typebot-builder --format '{{json .Config.Labels}}'`, and adjust
   `deploy/pibot/docker-compose.yml` if they differ.
4. Create the database and its non-superuser role in `typebot-db`:
   ```sh
   set -a; . /opt/chatbot/.env; set +a
   docker exec -i typebot-db psql -U <typebot-db admin user> -v pw="$POSTGRES_PASSWORD" < deploy/pibot/create-db.sql
   ```
5. Start it:
   ```sh
   cd /opt/chatbot
   docker compose -f deploy/pibot/docker-compose.yml --env-file .env up -d --build
   docker compose -f deploy/pibot/docker-compose.yml logs -f app
   ```
   Migrations run automatically on start. The app refuses to start if its DB role
   is a superuser.
6. Create the first platform owner (synthetic demo data, clearly labelled):
   ```sh
   docker compose -f deploy/pibot/docker-compose.yml exec \
     -e SEED_ADMIN_EMAIL=... -e SEED_ADMIN_PASSWORD=... app node packages/core/dist/src/cli/seed.js
   ```
7. Check `https://bot.pibot.io/api/health` returns `{"ok":true}`.

## Update / rollback

```sh
cd /opt/chatbot && git fetch && git checkout <release-tag>
docker compose -f deploy/pibot/docker-compose.yml --env-file .env up -d --build
```
Rollback = check out the previous tag and run the same command. Migrations are
forward-only; a release that needs a schema rollback ships its own down migration.

## Backups

The chatbot database lives in `typebot-db`, so include it explicitly:
`docker exec typebot-db pg_dump -U chatbot -Fc chatbot > chatbot-$(date +%F).dump`.
The gateway session volume (`chatbot_gateway-sessions`) holds WhatsApp login state;
treat it as secret. A restore drill into a test database is part of Phase 4.
