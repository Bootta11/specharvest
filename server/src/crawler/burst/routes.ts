import type { FastifyInstance } from "fastify";
import type { BurstStatus } from "@specharvest/shared";
import { z } from "zod";
import { env } from "../../config.ts";
import * as db from "../../db/sqlite.ts";
import { requireAdmin } from "../../auth/plugin.ts";
import { httpError } from "../../lib/http-error.ts";
import { digitalOcean } from "./digitalocean.ts";
import type { BurstManager } from "./index.ts";
import {
  burstAccountPatchSchema,
  burstAvailable,
  burstOverrides,
  burstSettingsResetPatchSchema,
  effectiveBurstSettings,
  envBurstSettings,
  getBurstImage,
  publicBurstAccount,
  resolvedBurstAccount,
  saveBurstAccount,
  saveBurstSettings,
} from "./settings.ts";

const utcStart = (now: number) => Date.parse(`${new Date(now).toISOString().slice(0, 10)}T00:00:00.000Z`);

export function registerBurstRoutes(app: FastifyInstance, getManager: () => BurstManager) {
  const status = async (): Promise<BurstStatus> => {
    const manager = getManager();
    const settings = effectiveBurstSettings();
    const now = Date.now();
    const usage = db.burstUsageSince(utcStart(now), now);
    const built = getBurstImage();
    const image = built
      ? { ...built, ageDays: (now - Date.parse(built.createdAt)) / 86_400_000, source: "build" as const }
      : env.BURST_IMAGE
        ? { id: env.BURST_IMAGE, name: env.BURST_IMAGE, createdAt: null, ageDays: null, source: "env" as const }
        : null;
    const provider = manager.provider();
    const priceHourly = provider ? await provider.hourlyPrice().catch(() => null) : null;
    const runningCost =
      priceHourly == null
        ? 0
        : db.listOpenBurstServers().reduce((sum, row) => sum + (Math.max(0, now - Math.max(row.startedAt, utcStart(now))) / 3_600_000) * priceHourly, 0);
    return {
      providerEnabled: env.BURST_PROVIDER === "digitalocean",
      available: burstAvailable(),
      settings,
      envDefaults: envBurstSettings(),
      overridden: Object.keys(burstOverrides()) as Array<keyof typeof settings>,
      account: publicBurstAccount(),
      running:
        manager.controller()?.servers().map((server) => {
          const stats = browserStats(server.name);
          return {
            name: server.name,
            state: server.state,
            startedAt: server.createdAt,
            readyAt: server.readyAt,
            active: stats?.active ?? 0,
            tabs: stats?.tabs ?? settings.tabs,
            pages: stats?.pages ?? 0,
          };
        }) ?? [],
      today: { hours: usage.ms / 3_600_000, limit: settings.maxHoursPerDay, costUsd: usage.costUsd + runningCost },
      history: db.listBurstServers(20),
      image,
      build: manager.imageBuilds.state(),
      priceHourly,
    };
  };

  // Avoid exposing browserFleet itself from browser.ts; controller rows are enriched through its public Fleet shape.
  const browserStats = (name: string) => getManager().controller()?.fleetStats?.(name) ?? null;

  app.get("/api/admin/burst", async (request) => {
    requireAdmin(request);
    return status();
  });

  app.put("/api/admin/burst", async (request) => {
    requireAdmin(request);
    saveBurstSettings(burstSettingsResetPatchSchema.parse(request.body));
    getManager().refresh();
    return status();
  });

  app.put("/api/admin/burst/account", async (request) => {
    requireAdmin(request);
    const manager = getManager();
    if (manager.busy()) throw httpError(409, "Account settings cannot change while a browser server or image build is running");
    const patch = burstAccountPatchSchema.parse(request.body);
    const changedIp = patch.allowedIp !== undefined;
    saveBurstAccount(patch);
    manager.refresh();
    if (changedIp && burstAvailable()) {
      const account = resolvedBurstAccount();
      await manager.provider()!.prepare({ tag: `${env.BURST_NAME}-burst`, allowedIp: account.allowedIp!, port: 9223 });
    }
    return status();
  });

  app.post("/api/admin/burst/test", async (request) => {
    requireAdmin(request);
    const { token } = z.object({ token: z.string().trim().min(1).max(500).optional() }).parse(request.body ?? {});
    const account = resolvedBurstAccount();
    const useToken = token ?? account.token.value;
    if (!useToken) throw httpError(400, "Enter a DigitalOcean token first");
    return digitalOcean({ token: useToken, region: account.region, size: account.size, image: env.BURST_IMAGE, sshKeyId: env.BURST_DO_SSH_KEY_ID }).testScopes();
  });

  app.get("/api/admin/burst/options", async (request) => {
    requireAdmin(request);
    const provider = getManager().provider();
    if (!provider) throw httpError(409, "Complete the DigitalOcean setup first");
    return provider.options();
  });

  app.post("/api/admin/burst/detect-ip", async (request) => {
    requireAdmin(request);
    const response = await fetch("https://api.ipify.org", { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw httpError(502, "Could not detect this server's public IP");
    return { ip: (await response.text()).trim() };
  });

  app.post("/api/admin/burst/image", async (request, reply) => {
    requireAdmin(request);
    const manager = getManager();
    if (!burstAvailable()) throw httpError(409, "Complete the DigitalOcean setup first");
    if (!manager.imageBuilds.start()) throw httpError(409, "An image build is already running");
    return reply.status(202).send(manager.imageBuilds.state());
  });
}
