# WhatsApp gateway container: QR / linked-device sessions. Internal network only.
FROM node:22.20.0-bookworm-slim AS build
WORKDIR /src
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY apps/web/package.json apps/web/
COPY apps/gateway/package.json apps/gateway/
RUN npm ci --no-audit --no-fund -w @chatbot/gateway
COPY apps/gateway apps/gateway
RUN npm run build -w @chatbot/gateway

FROM node:22.20.0-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /src/apps/gateway/dist ./dist
COPY apps/gateway/package.json ./
RUN mkdir -p /data/sessions && chown node:node /data/sessions
USER node
EXPOSE 3100
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3100/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/src/server.js"]
