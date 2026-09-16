# SigilKit indexer — container image.
#
# Two stages: the builder installs dev dependencies and compiles the TypeScript
# packages; the runtime stage keeps only production dependencies and the built output.
#
#   docker build -t sigilkit-indexer .
#   docker run --rm sigilkit-indexer --help
#   docker run --rm -v sigilkit-data:/data \
#     -e SIGILKIT_RPC_URL=https://your-rpc \
#     -e SIGILKIT_MANAGER=0xYourManager \
#     sigilkit-indexer watch
#
# The default command is `--help`, so a bare `docker run` explains itself instead of
# silently starting a long-running process.
#
# Contracts are NOT built here: this image ships the audit-trail service, and the
# Foundry toolchain would multiply the image size for no runtime benefit.

# ── build ─────────────────────────────────────────────────────────────────────────
FROM node:24-bookworm-slim AS build
WORKDIR /app

# Dependency manifests first, so a source-only change reuses the install layer.
COPY package.json package-lock.json ./
COPY packages/core/package.json ./packages/core/
COPY packages/indexer/package.json ./packages/indexer/
COPY packages/mcp/package.json ./packages/mcp/
COPY packages/demo-agent/package.json ./packages/demo-agent/
RUN npm ci

COPY packages ./packages
RUN npm run build --workspaces --if-present

# ── runtime ───────────────────────────────────────────────────────────────────────
FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production \
    SIGILKIT_DB_PATH=/data/audit.db \
    SIGILKIT_LOG_FORMAT=text

WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/core/package.json ./packages/core/
COPY packages/indexer/package.json ./packages/indexer/
COPY packages/mcp/package.json ./packages/mcp/
COPY packages/demo-agent/package.json ./packages/demo-agent/
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/packages/core/dist ./packages/core/dist
COPY --from=build /app/packages/indexer/dist ./packages/indexer/dist
COPY --from=build /app/packages/mcp/dist ./packages/mcp/dist

# The SQLite store lives on a volume; give the unprivileged user ownership of it.
RUN mkdir -p /data && chown -R node:node /data
VOLUME ["/data"]

USER node

ENTRYPOINT ["node", "packages/indexer/dist/cli.js"]
CMD ["--help"]
