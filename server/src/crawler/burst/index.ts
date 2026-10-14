import { env } from "../../config.ts";
import { browserFleet } from "../browser.ts";
import { createBurstController } from "./controller.ts";
import { digitalOcean, type DigitalOceanProvider } from "./digitalocean.ts";
import { createImageBuilds } from "./image.ts";
import { burstAvailable, effectiveBurstSettings, getBurstImage, resolvedBurstAccount } from "./settings.ts";

const HOURLY_MS = 60 * 60_000;

/** Owns the live provider, controller and image timer even when setup is completed after boot. */
export function startBurstServers() {
  let provider: DigitalOceanProvider | null = null;
  let providerKey = "";
  let controller: ReturnType<typeof createBurstController> | null = null;

  const getProvider = () => {
    if (!burstAvailable()) return null;
    const account = resolvedBurstAccount();
    const image = getBurstImage()?.id ?? env.BURST_IMAGE;
    const key = `${account.token.value}:${account.region}:${account.size}:${image}`;
    if (!provider || key !== providerKey) {
      provider = digitalOcean({ token: account.token.value!, region: account.region, size: account.size, image, sshKeyId: env.BURST_DO_SSH_KEY_ID });
      providerKey = key;
    }
    return provider;
  };

  const getConfig = () => {
    const settings = effectiveBurstSettings();
    const account = resolvedBurstAccount();
    return {
      tag: `${env.BURST_NAME}-burst`,
      allowedIp: account.allowedIp ?? "",
      enabled: settings.enabled,
      image: getBurstImage()?.id ?? env.BURST_IMAGE,
      maxServers: settings.maxServers,
      tabs: settings.tabs,
      minWaiting: settings.minWaiting,
      afterMs: settings.afterSeconds * 1000,
      idleMs: settings.idleMinutes * 60_000,
      maxLifetimeMs: settings.maxMinutes * 60_000,
      maxHoursPerDay: settings.maxHoursPerDay,
    };
  };

  const imageBuilds = createImageBuilds(getProvider, () => {
    const account = resolvedBurstAccount();
    return {
      tag: `${env.BURST_NAME}-burst`,
      prefix: `${env.BURST_NAME}-browser-`,
      allowedIp: account.allowedIp ?? "",
      autoRebuildDays: effectiveBurstSettings().autoRebuildDays,
    };
  });

  const refresh = () => {
    providerKey = "";
    if (!controller && getProvider()) {
      controller = createBurstController(() => getProvider()!, browserFleet, getConfig);
      controller.start();
      void imageBuilds.recover().then(() => imageBuilds.check());
    }
  };

  refresh();
  const timer = setInterval(() => {
    refresh();
    imageBuilds.check();
  }, HOURLY_MS);
  timer.unref();

  return {
    refresh,
    provider: getProvider,
    controller: () => controller,
    imageBuilds,
    busy: () => !!controller?.servers().length || imageBuilds.state().running,
    async close() {
      clearInterval(timer);
      await imageBuilds.close();
      await controller?.close();
    },
  };
}

export type BurstManager = ReturnType<typeof startBurstServers>;
