/** A rented server (crawler/burst/controller.ts), as the provider reports it. */
export interface BurstServer {
  id: string;
  name: string;
  /** Public IPv4; null until the provider has assigned one. */
  ip: string | null;
  /** Running and reachable as far as the provider knows. */
  active: boolean;
  /** When the provider created it (ms), if known. */
  createdAt?: number | null;
}

/** Name suffix of the server the image builder sets up (scripts/burst-image.ts); the leftover check spares it a while. */
export const IMAGE_BUILD_SUFFIX = "-image-build";
/** An image build takes ~5 min; one older than this is a leftover. */
export const IMAGE_BUILD_MAX_MS = 60 * 60_000;

/** A cloud that rents servers by the minute or hour. Every server carries `tag`, so leftovers can be found. */
export interface BurstProvider {
  readonly name: string;
  /** Lets `allowedIp` (only) reach `port` on servers tagged `tag`; safe to call again. */
  prepare(o: { tag: string; allowedIp: string; port: number }): Promise<void>;
  create(o: { name: string; tag: string; userData: string }): Promise<BurstServer>;
  /** null when the server no longer exists. */
  get(id: string): Promise<BurstServer | null>;
  /** Deleting a server that's already gone is fine. */
  delete(id: string): Promise<void>;
  list(tag: string): Promise<BurstServer[]>;
  /** What one server costs per hour (USD), for the cost log; null when unknown. */
  hourlyPrice(): Promise<number | null>;
}

/** The port the browser is reached on, behind a token in the path. */
export const BURST_PORT = 9223;

/** Packages and the browser's service; the service isn't enabled here (boot does that, with a token in place). */
const INSTALL = `export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q --no-install-recommends chromium fonts-liberation caddy
useradd --system --create-home --shell /usr/sbin/nologin crawler || true
cat > /etc/systemd/system/crawl-browser.service <<'UNIT'
[Unit]
Description=Headless Chromium for SpecHarvest
After=network-online.target
[Service]
User=crawler
ExecStart=/usr/bin/chromium --headless --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 --user-data-dir=/home/crawler/profile --no-first-run --no-default-browser-check --disable-gpu --disable-dev-shm-usage about:blank
Restart=always
RestartSec=2
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload`;

/** Marks a server set up for the image (scripts/burst-image.ts): Caddy answers this path, nothing else. */
export const IMAGE_READY_PATH = "/image-ready";

/**
 * First-boot script: Debian's Chromium headless on 127.0.0.1:9222 as an unprivileged user, and Caddy on BURST_PORT
 * passing only /<token>/… to it (HTTP and WebSocket), 403 for the rest. On a fresh Debian image it installs the
 * packages first (~45 s); on our image (BURST_IMAGE from "npm run burst:image") they are already there.
 */
export function burstUserData(token: string): string {
  if (!/^[a-f0-9]{32,}$/.test(token)) throw new Error("Burst token must be hex");
  return `#!/bin/bash
set -euo pipefail
if ! command -v chromium >/dev/null || ! command -v caddy >/dev/null || [ ! -f /etc/systemd/system/crawl-browser.service ]; then
${INSTALL}
fi
cat > /etc/caddy/Caddyfile <<'CADDY'
{
  admin off
}
:${BURST_PORT} {
  handle_path /${token}/* {
    reverse_proxy 127.0.0.1:9222
  }
  handle {
    respond 403
  }
}
CADDY
systemctl enable --now crawl-browser
systemctl restart caddy
`;
}

/**
 * Sets up a server to be saved as the image: all updates, the packages, a check that Chromium runs, and no secret
 * left behind (Caddy only answers IMAGE_READY_PATH, which tells the builder it's done; the browser isn't enabled,
 * its profile is removed).
 */
export function imageUserData(): string {
  return `#!/bin/bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get upgrade -y -q
${INSTALL}
runuser -u crawler -- timeout 60 chromium --headless --no-first-run --user-data-dir=/tmp/chromium-check --dump-dom about:blank >/dev/null
rm -rf /tmp/chromium-check /home/crawler/profile
apt-get clean
cat > /etc/caddy/Caddyfile <<'CADDY'
{
  admin off
}
:${BURST_PORT} {
  respond ${IMAGE_READY_PATH} "ok" 200
  respond 403
}
CADDY
systemctl restart caddy
`;
}
