# syntax=docker/dockerfile:1
# glibc is required: onnxruntime-node (embeddings) ships no musl build, so no Alpine.
# Builder and runtime are both Debian 13 so native modules link against the same glibc.
# The runtime is distroless (no shell, no npm, no apt). Both are pinned by digest in the
# FROM lines so Dependabot can bump them.

FROM node:24-trixie-slim@sha256:173f125896c3b47ddf056734c7ea789d04595a6a08769a8f78e0df642781fb66 AS builder
RUN apt-get update && apt-get upgrade -y \
  && apt-get install -y --no-install-recommends binutils \
  && rm -rf /var/lib/apt/lists/*
# npm 10 hits an arborist bug on this dependency tree; pin npm 11 regardless of the bundled npm.
RUN npm install -g npm@11 --no-audit --no-fund
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY client/package.json client/
# The extension isn't part of the image, but npm ci checks every workspace in the lockfile.
COPY extension/package.json extension/
RUN npm ci --no-audit --no-fund
COPY tsconfig.base.json ./
COPY scripts/app-bundle.mjs scripts/
COPY shared shared
COPY client client
COPY server server
ARG TARGETARCH
# The commit, for the UI's version and the Android app's live-update bundle (docs/app-updates.md).
ARG GIT_SHA=""
# The bundle is signed when the build gets the bundle_key secret (CI); without it, apps ignore the bundle.
RUN --mount=type=secret,id=bundle_key,required=false \
  npm run build --workspace client \
  && (cd client && GIT_SHA="$GIT_SHA" npx vite build --mode app --outDir dist-app) \
  && GIT_SHA="$GIT_SHA" node scripts/app-bundle.mjs client/dist-app client/dist-app --key /run/secrets/bundle_key \
  && npm prune --omit=dev --no-audit --no-fund \
  && mkdir -p /app/data \
  # onnxruntime-node ships binaries for every OS/arch (~300 MB); keep only this image's.
  && ort=node_modules/onnxruntime-node/bin/napi-v6 \
  && find "$ort" -mindepth 1 -maxdepth 1 ! -name linux -exec rm -rf {} + \
  && find "$ort/linux" -mindepth 1 -maxdepth 1 ! -name "$(case "$TARGETARCH" in arm64) echo arm64;; *) echo x64;; esac)" -exec rm -rf {} + \
  # transformers' Node build bundles what it needs from onnxruntime-web (~150 MB of browser WASM).
  && rm -rf node_modules/onnxruntime-web \
  # LanceDB's Linux binary ships with debug symbols (~390 MB -> ~255 MB stripped).
  && strip --strip-unneeded node_modules/@lancedb/lancedb-linux-*/*.node

FROM gcr.io/distroless/nodejs24-debian13:nonroot@sha256:55de7e48a8414e7aff825207c0b3c0f7db3b10133efc50d748560c27c9053be1
WORKDIR /app
ARG GIT_SHA=""
ENV NODE_ENV=production \
    PORT=3100 \
    DATA_DIR=/app/data \
    APP_GIT_SHA=${GIT_SHA}
COPY --from=builder /app/node_modules node_modules
COPY --from=builder /app/package.json ./
COPY --from=builder /app/shared shared
COPY --from=builder /app/server/package.json server/
COPY --from=builder /app/server/healthcheck.mjs server/
COPY --from=builder /app/server/src server/src
COPY --from=builder /app/client/dist client/dist
COPY --from=builder /app/client/dist-app.zip /app/client/dist-app.json client/
# Distroless has no shell for mkdir/chown: copy an empty dir owned by the nonroot user (65532),
# so a fresh named volume mounted here is writable.
COPY --from=builder --chown=nonroot:nonroot /app/data data
USER nonroot
VOLUME ["/app/data"]
EXPOSE 3100
# --start-interval (Docker 25+): checks every 2 s until healthy, so a reverse proxy that waits for "healthy"
# (Traefik) routes to a new container seconds after an update instead of after the first 30 s interval.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --start-interval=2s --retries=3 \
  CMD ["/nodejs/bin/node", "/app/server/healthcheck.mjs"]
# The image's entrypoint is node itself; the server runs TypeScript through tsx.
CMD ["--import", "tsx", "server/src/index.ts"]
