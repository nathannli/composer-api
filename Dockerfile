# Node image for the bridge (Bun HTTP/2 breaks @cursor/sdk streaming).
FROM node:22-bookworm-slim AS bridge-base
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM bridge-base AS bridge
COPY --chown=node:node scripts ./scripts
RUN mkdir -p /context-cache /workspace \
    && chown node:node /context-cache /workspace
ENV CURSOR_SDK_BRIDGE_HOST=0.0.0.0
ENV CURSOR_SDK_BRIDGE_PORT=8792
ENV CURSOR_SDK_WORKING_DIRECTORY=/workspace
USER node
CMD ["node", "scripts/cursor-sdk-local-agent-bridge.mjs"]

FROM oven/bun:1.3.13-slim AS api-base
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM api-base AS api
COPY --chown=bun:bun server ./server
COPY --chown=bun:bun worker ./worker
RUN mkdir -p /context-cache && chown bun:bun /context-cache
ENV HOST=0.0.0.0
ENV PORT=8788
ENV CURSOR_SDK_BRIDGE_URL=http://bridge:8792/sdk
ENV CURSOR_SDK_WORKING_DIRECTORY=/workspace
USER bun
CMD ["bun", "run", "server/index.ts"]
