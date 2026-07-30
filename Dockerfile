# syntax=docker/dockerfile:1.7
#
# Public Buzz TypeScript relay image. It contains no native-language compiler,
# sidecar, or FFI dependency.

ARG NODE_VERSION=24
ARG DEBIAN_VERSION=bookworm
ARG EXTRA_CA_CERTS=
ARG NPM_REGISTRY=

FROM node:${NODE_VERSION}-${DEBIAN_VERSION}-slim AS builder
WORKDIR /build

ARG EXTRA_CA_CERTS
ARG NPM_REGISTRY
COPY ${EXTRA_CA_CERTS:-deploy/empty-ca.crt} /tmp/extra-ca/src
RUN chmod 0644 /tmp/extra-ca/src \
    && apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && if [ -n "${EXTRA_CA_CERTS}" ]; then \
      cp /tmp/extra-ca/src /usr/local/share/ca-certificates/extra-proxy-ca.crt \
      && update-ca-certificates \
    ; fi \
    && rm -rf /var/lib/apt/lists/*
ENV NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt \
    COREPACK_NPM_REGISTRY=${NPM_REGISTRY} \
    COREPACK_INTEGRITY_KEYS=${NPM_REGISTRY:+0} \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    CI=true
RUN if [ -n "${NPM_REGISTRY}" ]; then \
      echo "registry=${NPM_REGISTRY}" > /build/.npmrc; \
    fi \
    && corepack enable

COPY . .
RUN pnpm \
      --config.store-dir=/pnpm/store \
      --config.trust-lockfile=true \
      --network-concurrency=8 \
      --fetch-retries=5 \
      --fetch-timeout=600000 \
      --config.allow-unused-patches=true \
      install --frozen-lockfile \
      --filter @buzz/relay... \
      --filter @buzz/admin... \
      --filter @buzz/pair-relay...
RUN pnpm \
      --config.store-dir=/pnpm/store \
      --config.trust-lockfile=true \
      --network-concurrency=8 \
      --fetch-retries=5 \
      --fetch-timeout=600000 \
      --config.allow-unused-patches=true \
      install --frozen-lockfile \
      --filter buzz-web
RUN pnpm \
      --config.store-dir=/pnpm/store \
      --config.trust-lockfile=true \
      --network-concurrency=8 \
      --fetch-retries=5 \
      --fetch-timeout=600000 \
      --config.allow-unused-patches=true \
      install --frozen-lockfile \
      --filter buzz-admin-web
RUN pnpm --filter @buzz/relay --filter @buzz/admin --filter @buzz/pair-relay build \
    && pnpm -C web build \
    && pnpm -C admin-web build
RUN pnpm --config.store-dir=/pnpm/store --config.trust-lockfile=true --network-concurrency=8 --fetch-retries=5 --fetch-timeout=600000 --config.allow-unused-patches=true --filter @buzz/relay deploy --prod /out/relay \
    && pnpm --config.store-dir=/pnpm/store --config.trust-lockfile=true --network-concurrency=8 --fetch-retries=5 --fetch-timeout=600000 --config.allow-unused-patches=true --filter @buzz/admin deploy --prod /out/admin \
    && pnpm --config.store-dir=/pnpm/store --config.trust-lockfile=true --network-concurrency=8 --fetch-retries=5 --fetch-timeout=600000 --config.allow-unused-patches=true --filter @buzz/pair-relay deploy --prod /out/pair-relay \
    && test -f /out/relay/node_modules/@buzz/core/dist/index.js \
    && test -f /out/admin/node_modules/@buzz/db/dist/index.js \
    && test -f /out/pair-relay/node_modules/@buzz/core/dist/index.js \
    && mkdir -p /artifacts \
    && tar --owner=1000 --group=1000 -C /out/relay -czf /artifacts/relay.tgz . \
    && tar --owner=1000 --group=1000 -C /out/admin -czf /artifacts/admin.tgz . \
    && tar --owner=1000 --group=1000 -C /out/pair-relay -czf /artifacts/pair-relay.tgz .

FROM node:${NODE_VERSION}-${DEBIAN_VERSION}-slim AS runtime-base

LABEL org.opencontainers.image.title="Buzz" \
      org.opencontainers.image.description="TypeScript WebSocket relay server for the Buzz communications platform" \
      org.opencontainers.image.source="https://github.com/block/buzz" \
      org.opencontainers.image.url="https://github.com/block/buzz" \
      org.opencontainers.image.documentation="https://github.com/block/buzz#readme" \
      org.opencontainers.image.licenses="Apache-2.0"

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl git openssl \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p \
      /data/git \
      /var/lib/buzz \
      /srv/buzz/relay \
      /srv/buzz/admin \
      /srv/buzz/pair-relay \
    && chown -R node:node /data/git /var/lib/buzz /srv/buzz

COPY --from=builder /artifacts /tmp/buzz-artifacts
COPY --from=builder --chown=node:node /build/migrations /srv/buzz/migrations
COPY --from=builder --chown=node:node /build/schema /srv/buzz/schema
COPY --from=builder --chown=node:node /build/web/dist /srv/buzz/web
COPY --from=builder --chown=node:node /build/admin-web/dist /srv/buzz/admin-web

RUN tar -xzf /tmp/buzz-artifacts/relay.tgz -C /srv/buzz/relay \
    && tar -xzf /tmp/buzz-artifacts/admin.tgz -C /srv/buzz/admin \
    && tar -xzf /tmp/buzz-artifacts/pair-relay.tgz -C /srv/buzz/pair-relay \
    && rm -rf /tmp/buzz-artifacts \
    && chmod 0755 \
      /srv/buzz/relay/dist/main.js \
      /srv/buzz/admin/dist/main.js \
      /srv/buzz/pair-relay/dist/main.js \
    && ln -s /srv/buzz/relay/dist/main.js /usr/local/bin/buzz-relay \
    && ln -s /srv/buzz/admin/dist/main.js /usr/local/bin/buzz-admin \
    && ln -s /srv/buzz/pair-relay/dist/main.js /usr/local/bin/buzz-pair-relay \
    && test -f /srv/buzz/relay/node_modules/@buzz/core/dist/index.js

ENV NODE_ENV=production \
    BUZZ_WEB_DIR=/srv/buzz/web \
    BUZZ_ADMIN_WEB_DIR=/srv/buzz/admin-web

EXPOSE 3000 8080 9102
USER node:node
WORKDIR /srv/buzz
ENTRYPOINT ["/usr/local/bin/buzz-relay"]

# JavaScript source maps are retained in both variants. Keeping the historical
# debug target avoids breaking release automation while producing identical
# TypeScript runtime behavior.
FROM runtime-base AS runtime-debug
FROM runtime-debug AS runtime
