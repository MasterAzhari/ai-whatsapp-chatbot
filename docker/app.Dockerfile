# App container: website + API (Next.js) and the outbox worker, supervised together.
FROM node:22.20.0-bookworm-slim AS build
WORKDIR /src
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY apps/web/package.json apps/web/
COPY apps/gateway/package.json apps/gateway/
RUN npm ci --no-audit --no-fund
COPY packages/core packages/core
COPY apps/web apps/web
RUN npm run build -w @chatbot/core && npm run build -w @chatbot/web

FROM node:22.20.0-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY apps/web/package.json apps/web/
COPY apps/gateway/package.json apps/gateway/
RUN npm ci --omit=dev --no-audit --no-fund -w @chatbot/core -w @chatbot/web && npm cache clean --force
COPY --from=build /src/packages/core/dist packages/core/dist
COPY packages/core/migrations packages/core/migrations
COPY --from=build /src/apps/web/.next apps/web/.next
COPY apps/web/next.config.mjs apps/web/
COPY docker/start-app.mjs ./
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "start-app.mjs"]
