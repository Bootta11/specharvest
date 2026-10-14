import type { FastifyInstance } from "fastify";
import { browserTestSchema, type BrowserTestResult } from "@specharvest/shared";
import { z } from "zod";
import * as db from "../db/sqlite.ts";
import { requireAdmin } from "../auth/plugin.ts";
import { httpError } from "../lib/http-error.ts";
import { errorMessage } from "../lib/logger.ts";
import { browserFleet, testBrowserConnection } from "./browser.ts";
import { capacityTester, type CapacityTarget } from "./capacity.ts";
import { createBrowser, credentialsOf, deleteBrowser, listBrowserStatus, updateBrowser } from "./browsers.ts";

const idParam = (params: unknown) => {
  const id = Number((params as { id?: string }).id);
  if (!Number.isInteger(id) || id <= 0) throw httpError(400, "Invalid id");
  return id;
};

/** A capacity test pauses its browser in the pool; changing or deleting it meanwhile would swap the paused entry. */
function assertNotUnderTest(id: number) {
  const row = db.getBrowser(id);
  if (row && capacityTester().busyWith() === row.name) throw httpError(409, "A capacity test is running on this browser — stop it first");
}

function capacityTarget(name: string): CapacityTarget {
  const fromEnv = browserFleet.envBrowser(name);
  if (fromEnv) return { name, id: null, ...fromEnv };
  const row = db.listBrowsers().find((b) => b.name === name);
  if (!row) throw httpError(404, `No browser named "${name}"`);
  return { name, id: row.id, url: row.url, creds: credentialsOf(row) };
}

/** Admin: the remote browsers crawl pages run in (crawler/browsers.ts). */
export function registerBrowserRoutes(app: FastifyInstance) {
  app.get("/api/admin/browsers", async (request) => {
    requireAdmin(request);
    return listBrowserStatus();
  });

  app.post("/api/admin/browsers", async (request, reply) => {
    requireAdmin(request);
    createBrowser(request.body);
    return reply.status(201).send(listBrowserStatus());
  });

  app.put("/api/admin/browsers/:id", async (request) => {
    requireAdmin(request);
    const id = idParam(request.params);
    assertNotUnderTest(id);
    updateBrowser(id, request.body);
    return listBrowserStatus();
  });

  app.delete("/api/admin/browsers/:id", async (request) => {
    requireAdmin(request);
    const id = idParam(request.params);
    assertNotUnderTest(id);
    deleteBrowser(id);
    return listBrowserStatus();
  });

  /** Tries the entered URL and keys; empty fields fall back to the saved browser `id`. Never returns secrets. */
  app.post("/api/admin/browsers/test", async (request): Promise<BrowserTestResult> => {
    requireAdmin(request);
    const input = browserTestSchema.parse(request.body ?? {});
    const saved = input.id !== undefined ? db.getBrowser(input.id) : null;
    if (input.id !== undefined && !saved) throw httpError(404, "Not found");
    const savedCreds = saved ? credentialsOf(saved) : {};
    const url = input.url || saved?.url;
    if (!url) throw httpError(400, "Enter the browser's URL");
    if (!/^wss?:\/\/\S+$/.test(url) || !URL.canParse(url)) throw httpError(400, "URL must start with ws:// or wss://");
    try {
      const version = await testBrowserConnection(url, {
        apiKey: input.apiKey || savedCreds.apiKey,
        username: input.username || savedCreds.username,
        password: input.password || savedCreds.password,
      });
      return { ok: true, version };
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
  });

  // ---------- Capacity test (crawler/capacity.ts) ----------

  app.get("/api/admin/browsers/capacity", async (request) => {
    requireAdmin(request);
    return { run: capacityTester().state() };
  });

  app.post("/api/admin/browsers/capacity", async (request, reply) => {
    requireAdmin(request);
    const { name } = z.object({ name: z.string().trim().min(1).max(100) }).parse(request.body);
    const target = capacityTarget(name);
    return reply.status(202).send({ run: capacityTester().start(target) });
  });

  app.delete("/api/admin/browsers/capacity", async (request) => {
    requireAdmin(request);
    capacityTester().stop();
    return { run: capacityTester().state() };
  });
}
