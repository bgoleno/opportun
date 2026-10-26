# syntax=docker/dockerfile:1
# Opportun container image (NFR-OPS1). Build from the repository root:
#   docker build -f deploy/Dockerfile -t opportun .
# or let deploy/compose.yml build it. The server runs as the non-root `opportun` user,
# keeps its state in /data (attachments, backups, exports, master.key) and /sqlite
# (opportun.db alone; issue #179), and is meant to run with a read-only root filesystem.

ARG NODE_VERSION=22

FROM node:${NODE_VERSION}-slim AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true
# pnpm comes from the packageManager field in package.json.
RUN corepack enable
WORKDIR /src

FROM base AS build
# Dependencies first, keyed on the lockfile only, so source edits reuse this layer.
# .npmrc carries ignore-scripts=true: no dependency lifecycle script runs here either
# (better-sqlite3 and argon2 ship prebuilt binaries).
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm fetch --frozen-lockfile
COPY . .
RUN pnpm install --frozen-lockfile --offline
RUN pnpm --filter @opportun/web build
# The browser extension ships as a download the running server serves (FR-C5): built
# here, where the toolchain already exists, because the runtime stage deliberately has none.
RUN pnpm --filter @opportun/extension build
# A self-contained production tree for the server: runtime dependencies only, with the
# workspace packages (core, ai) copied in. Tests and dev tooling are dropped.
RUN pnpm --filter @opportun/server --prod deploy /out/server \
 && rm -rf /out/server/test /out/server/scripts /out/server/data /out/server/drizzle.config.ts \
    /out/server/drizzle-pg.config.ts

FROM node:${NODE_VERSION}-slim AS runtime
# OCI labels, on the runtime stage because that is the image that ships. `source` is what
# GitHub reads to link the container package to its repository: with it, the package is listed
# on the public repository's page and shows that repository's README, instead of being attached
# only to wherever the workflow that pushed it happens to run.
LABEL org.opencontainers.image.source="https://github.com/bgoleno/opportun" \
      org.opencontainers.image.description="An open source, AI-assisted manager for the full job search lifecycle." \
      org.opencontainers.image.licenses="Apache-2.0"
# The Postgres client tools' major version: pg_dump must be at least the server's and its
# archives restore cleanly only into the same major (DB_DIALECT=postgres backups, Task 12).
ARG PG_CLIENT_MAJOR=16
# curl is for HEALTHCHECK and for fetching the PGDG signing key. postgresql-client (pg_dump,
# pg_restore) comes from the PostgreSQL project's apt repository (PGDG), pinned to
# PG_CLIENT_MAJOR: Debian's own repository carries one other major only. Fixed uid/gid so a
# bind-mounted ./data can be chowned to it.
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
      -o /usr/share/keyrings/pgdg.asc \
 && . /etc/os-release \
 && echo "deb [signed-by=/usr/share/keyrings/pgdg.asc] https://apt.postgresql.org/pub/repos/apt ${VERSION_CODENAME}-pgdg main" \
      > /etc/apt/sources.list.d/pgdg.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends "postgresql-client-${PG_CLIENT_MAJOR}" \
 && pg_dump --version | grep -q " ${PG_CLIENT_MAJOR}\." \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --system --gid 10001 opportun \
 && useradd --system --uid 10001 --gid opportun --no-create-home \
      --home-dir /nonexistent --shell /usr/sbin/nologin opportun \
 && mkdir -p /data /sqlite \
 && chown opportun:opportun /data /sqlite \
 && chmod 0700 /data /sqlite
# OPPORTUN_HOST: inside the container the server must listen on all interfaces so Caddy
# (on the compose network) can reach it; the host-side exposure is set by compose ports.
ENV NODE_ENV=production \
    DATA_DIR=/data \
    SQLITE_DIR=/sqlite \
    OPPORTUN_HOST=0.0.0.0 \
    PORT=8080 \
    WEB_DIR=/app/web/dist \
    ARTIFACTS_DIR=/app/artifacts
WORKDIR /app/server
# Application files stay root-owned: the app user can read them but not change them.
COPY --from=build /out/server /app/server
COPY --from=build /src/apps/web/dist /app/web/dist
# Unpacked extensions, one directory per browser target, zipped per request by the
# artifacts route with the server's own address added.
COPY --from=build /src/packages/extension/dist/chrome /app/artifacts/chrome
COPY --from=build /src/packages/extension/dist/firefox /app/artifacts/firefox
USER opportun
VOLUME ["/data", "/sqlite"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT}/healthz" > /dev/null || exit 1
# node is PID 1 (compose adds an init); src/index.ts handles SIGTERM and closes cleanly.
CMD ["node", "--import", "tsx", "src/index.ts"]
