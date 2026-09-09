# syntax=docker/dockerfile:1.7
#
# Ascendant Ledger — production image.
#
# Debian slim is used because better-sqlite3 is a native addon and glibc
# prebuilds are broadly available for Node 22 on x86_64/arm64.

# ---------------------------------------------------------------------------
# Stage 1 — install and compile the server
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS server-build

WORKDIR /build/server

# better-sqlite3 normally downloads a prebuilt binary, but keep native build
# tooling in the disposable builder stage so an npm/prebuild miss does not make
# deployment architecture-dependent.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

COPY server/package.json server/package-lock.json* ./
RUN npm ci --no-audit --no-fund

COPY server/tsconfig.json ./
COPY server/src ./src
COPY server/web ./web
RUN npm run build

# TypeScript does not copy non-TS assets. The migration runner resolves SQL
# migrations relative to dist/db/migrate.js, so copy them into dist explicitly.
RUN mkdir -p dist/db/migrations \
 && cp -a src/db/migrations/. dist/db/migrations/

RUN npm prune --omit=dev

# ---------------------------------------------------------------------------
# Stage 2 — runtime
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
    DATA_DIR=/data \
    HOST=0.0.0.0 \
    PORT=8080

# gosu lets the entrypoint repair permissions on a newly-created Docker volume,
# then run the application as the unprivileged ledger user.
RUN apt-get update \
 && apt-get install -y --no-install-recommends gosu \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --gid 10001 ledger \
 && useradd --uid 10001 --gid 10001 --shell /usr/sbin/nologin --no-create-home ledger \
 && mkdir -p /data \
 && chown -R ledger:ledger /data

WORKDIR /app

COPY --from=server-build --chown=root:root /build/server/node_modules ./node_modules
COPY --from=server-build --chown=root:root /build/server/dist ./dist
COPY --from=server-build --chown=root:root /build/server/web ./web
COPY --from=server-build --chown=root:root /build/server/package.json ./package.json
COPY --chown=root:root docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

VOLUME ["/data"]
EXPOSE 8080

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "dist/index.js"]
