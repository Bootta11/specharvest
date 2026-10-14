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
import { buildImage } from "../crawler/burst/image.ts";

const BASE_IMAGE = "debian-13-x64";

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

const ours = async () => (await provider.listSnapshots()).filter((s) => s.name.startsWith(prefix)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));

if (opts.list) {
  for (const s of await ours()) console.log(`${s.id}  ${s.name}  ${s.sizeGb} GB  ${s.createdAt}`);
  process.exit(0);
}

const snapshot = await buildImage(provider, { tag, prefix, allowedIp: env.BURST_ALLOWED_IP!, keep, base: opts.base }, console.log);
console.log(`\nSet BURST_IMAGE=${snapshot.id}`);
