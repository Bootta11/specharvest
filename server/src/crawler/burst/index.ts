import { env } from "../../config.ts";
import { browserFleet } from "../browser.ts";
import { createBurstController } from "./controller.ts";
import { digitalOcean } from "./digitalocean.ts";

/** Starts the on-demand browser servers when BURST_PROVIDER is set; returns the controller (null when off). */
export function startBurstServers() {
  if (env.BURST_PROVIDER !== "digitalocean") return null;
  const provider = digitalOcean({ token: env.BURST_DO_TOKEN!, region: env.BURST_REGION, size: env.BURST_SIZE, image: env.BURST_IMAGE, sshKeyId: env.BURST_DO_SSH_KEY_ID });
  const controller = createBurstController(provider, browserFleet, {
    tag: `${env.BURST_NAME}-burst`,
    allowedIp: env.BURST_ALLOWED_IP!,
    maxServers: env.BURST_MAX_SERVERS,
    tabs: env.BURST_TABS,
    minWaiting: env.BURST_MIN_WAITING,
    afterMs: env.BURST_AFTER_SECONDS * 1000,
    idleMs: env.BURST_IDLE_MINUTES * 60_000,
    maxLifetimeMs: env.BURST_MAX_MINUTES * 60_000,
    maxHoursPerDay: env.BURST_MAX_HOURS_PER_DAY,
  });
  controller.start();
  return controller;
}
