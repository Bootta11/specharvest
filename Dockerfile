# syntax=docker/dockerfile:1
# glibc is required: onnxruntime-node (embeddings) ships no musl build, so no Alpine.
# Builder and runtime are both Debian 13 so native modules link against the same glibc.
# The runtime is distroless (no shell, no npm, no apt). Both are pinned by digest in the
# FROM lines so Dependabot can bump them.

FROM node:25-trixie-slim@sha256:aabbe39553d15ede8a97cc60c9e1a97034ff772afcf696ea42b94e7f5f2ec71b AS builder
RUN apt-get update && apt-get upgrade -y \
  && apt-get install -y --no-install-recommends binutils \
  && rm -rf /var/lib/apt/lists/*
# npm 10 (bundled with node:22) hits an arborist bug on this dependency tree; use npm 11.
RUN npm install -g npm@11 --no-audit --no-fund
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci --no-audit --no-fund
COPY tsconfig.base.json ./
COPY shared shared
COPY client client
COPY server server
ARG TARGETARCH
RUN npm run build --workspace client \
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

FROM gcr.io/distroless/nodejs22-debian13:nonroot@sha256:ec2313763dd43931543bd03830466e0c409ce73a487e8d46f10db72d3b816c1c
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
# Distroless has no shell for mkdir/chown: copy an empty dir owned by the nonroot user (65532),
# so a fresh named volume mounted here is writable.
COPY --from=builder --chown=nonroot:nonroot /app/data data
USER nonroot
VOLUME ["/app/data"]
EXPOSE 3100
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["/nodejs/bin/node", "/app/server/healthcheck.mjs"]
# The image's entrypoint is node itself; the server runs TypeScript through tsx.
CMD ["--import", "tsx", "server/src/index.ts"]
