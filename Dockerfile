# syntax=docker/dockerfile:1.7
#
# Multi-stage build for @kb/mcp-server.
#
# Why node:22-slim (Debian) instead of alpine:
#   better-sqlite3 ships native bindings linked against glibc. Alpine uses
#   musl, which forces a from-source rebuild on every image build (+30s)
#   and occasionally hits ABI issues. Slim trades ~80MB of image size for
#   a clean prebuilt binary install. For an internal-team server image
#   that's the right tradeoff.

# ── Stage 1: builder ────────────────────────────────────────────────────────
# Full dev deps + TypeScript compile. Output lives in /app/dist.
FROM node:22-slim AS builder

WORKDIR /app

# Install build deps for better-sqlite3 native compile in case prebuilds
# don't match the runner architecture. Removed in the runtime stage.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

# Copy everything tsc needs BEFORE `npm ci`. Reason: package.json declares
# `prepare: npm run build`, which npm runs automatically as part of `npm ci`.
# Without tsconfig.json + src/ present, tsc fails to find a project. We
# trade a smaller portion of the layer cache (a source change re-runs
# `npm ci`) for a Dockerfile that's consistent with the prepare hook —
# important because that hook is what lets downstream consumers (the
# kb-content repo) install this package from a git URL.
COPY package.json package-lock.json tsconfig.json ./
COPY src ./src
RUN npm ci

# Defensive re-run of build in case prepare was skipped (e.g. someone
# adds --ignore-scripts later). Cheap, and keeps the explicit signal.
RUN npm run build

# Prune to production deps only. We copy this node_modules into the
# runtime stage so we ship just the runtime closure (no TypeScript, no
# vitest, no eslint).
RUN npm prune --omit=dev


# ── Stage 2: runtime ────────────────────────────────────────────────────────
# Minimal image: node + pruned modules + compiled JS + migrations.
FROM node:22-slim AS runtime

# wget is used by the docker-compose healthcheck. ca-certificates keeps
# any future outbound HTTPS (e.g. embeddings) working.
RUN apt-get update && apt-get install -y --no-install-recommends \
      wget ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Run as the non-root `node` user that's already in the base image.
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/dist ./dist
COPY --chown=node:node migrations ./migrations
COPY --chown=node:node package.json ./

# /data holds the SQLite file. Declared as a volume so orchestrators
# treat it as external state — `docker run -v ./data:/data` mounts it.
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]

ENV NODE_ENV=production \
    KB_DB_PATH=/data/kb.db \
    KB_PORT=3001

EXPOSE 3001

USER node

# CMD (not ENTRYPOINT) so operators can override with `docker run ...
# kb-ingest ingest --db /data/kb.db ...` to reingest in-place.
CMD ["node", "dist/server/http.js"]
