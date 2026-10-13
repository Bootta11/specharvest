/**
 * Builds the image on-demand browser servers start from (docs/deployment.md#extra-browser-servers-on-demand):
 * a fresh Debian droplet with all updates, Chromium and Caddy installed, saved as a snapshot. Servers started from
 * it skip the install and are ready ~40 s sooner. Rebuild it weekly for Chromium's security updates.
 *
 *   npm run burst:image                  # build, keep this and the previous image, delete older ones
 *   npm run burst:image -- --keep 3      # keep three
 *   npm run burst:image -- --list        # just show our images
 *
 * Needs BURST_PROVIDER=digitalocean, BURST_DO_TOKEN and BURST_ALLOWED_IP = the public IP of the machine running this
 * (the firewall lets only that IP check on the build). Prints the BURST_IMAGE value to set.
 */
import { parseArgs } from "node:util";
import { env } from "../config.ts";
import { digitalOcean } from "../crawler/burst/digitalocean.ts";
import { BURST_PORT, IMAGE_BUILD_SUFFIX, IMAGE_READY_PATH, imageUserData } from "../crawler/burst/provider.ts";

const BASE_IMAGE = "debian-13-x64";
const READY_TIMEOUT_MS = 15 * 60_000;

const { values: opts } = parseArgs({
  options: {
    keep: { type: "string", default: "2" },
    list: { type: "boolean", default: false },
    base: { type: "string", default: BASE_IMAGE },
  },
});
const keep = Number(opts.keep);
if (!Number.isInteger(keep) || keep < 1) throw new Error("--keep must be 1 or more");

if (env.BURST_PROVIDER !== "digitalocean") {
  console.error("Set BURST_PROVIDER=digitalocean, BURST_DO_TOKEN and BURST_ALLOWED_IP (this machine's public IP) first.");
  process.exit(1);
}

const tag = `${env.BURST_NAME}-burst`;
const prefix = `${env.BURST_NAME}-browser-`;
const provider = digitalOcean({ token: env.BURST_DO_TOKEN!, region: env.BURST_REGION, size: env.BURST_SIZE, image: opts.base!, sshKeyId: env.BURST_DO_SSH_KEY_ID });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const elapsed = () => `${((Date.now() - t0) / 60_000).toFixed(1)} min`;
const step = (msg: string) => console.log(`[${elapsed()}] ${msg}`);

const ours = async () => (await provider.listSnapshots()).filter((s) => s.name.startsWith(prefix)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));

if (opts.list) {
  for (const s of await ours()) console.log(`${s.id}  ${s.name}  ${s.sizeGb} GB  ${s.createdAt}`);
  process.exit(0);
}

let dropletId: string | null = null;
try {
  step(`Firewall: only ${env.BURST_ALLOWED_IP} may reach port ${BURST_PORT}`);
  await provider.prepare({ tag, allowedIp: env.BURST_ALLOWED_IP!, port: BURST_PORT });

  step(`Creating a ${opts.base} droplet (${env.BURST_SIZE}, ${env.BURST_REGION})`);
  const droplet = await provider.create({ name: `${tag}${IMAGE_BUILD_SUFFIX}`, tag, userData: imageUserData() });
  dropletId = droplet.id;

  step("Waiting for updates and the install (~2 min)");
  const deadline = Date.now() + READY_TIMEOUT_MS;
  for (;;) {
    if (Date.now() > deadline) throw new Error(`The droplet wasn't set up within ${READY_TIMEOUT_MS / 60_000} min`);
    await sleep(10_000);
    const info = await provider.get(dropletId);
    if (!info) throw new Error("The droplet disappeared");
    if (!info.ip || !info.active) continue;
    const ok = await fetch(`http://${info.ip}:${BURST_PORT}${IMAGE_READY_PATH}`, { signal: AbortSignal.timeout(5_000) })
      .then((r) => r.ok)
      .catch(() => false);
    if (ok) break;
  }

  step("Set up; powering off");
  await provider.powerOff(dropletId);
  const name = `${prefix}${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "")}`;
  step(`Saving snapshot ${name} (a few minutes)`);
  const snap = await provider.snapshot(dropletId, name);
  step(`Saved: ${snap.id} (${snap.sizeGb} GB)`);

  for (const old of (await ours()).slice(keep)) {
    step(`Deleting old image ${old.name} (${old.id})`);
    await provider.deleteSnapshot(old.id);
  }
  console.log(`\nSet BURST_IMAGE=${snap.id}`);
} finally {
  if (dropletId) {
    step("Deleting the build droplet");
    await provider.delete(dropletId).catch((err: unknown) => console.error(`Couldn't delete droplet ${dropletId} — delete it by hand`, err));
  }
  step("Done");
}
