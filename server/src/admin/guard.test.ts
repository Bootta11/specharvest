import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import type { BurstManager } from "../crawler/burst/index.ts";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "specharvest-admin-guard-"));
process.env.DATA_DIR = dataDir;
delete process.env.PUPPETEER_WS_ENDPOINT;

const { default: Fastify } = await import("fastify");
const { registerAuth, SESSION_COOKIE } = await import("../auth/plugin.ts");
const users = await import("../auth/users.ts");
const sessions = await import("../auth/sessions.ts");
const apiKeys = await import("../auth/api-keys.ts");
const { errorHandler } = await import("../lib/http-error.ts");
const { ADMIN_PREFIX, registerAdminRoutes } = await import("./routes.ts");

afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }));

// Never reached: the guard answers before any handler runs.
const manager = {} as BurstManager;

const app = Fastify();
await registerAuth(app);
app.setErrorHandler(errorHandler);
const routes: Array<{ method: string; url: string }> = [];
app.addHook("onRoute", (r) => {
  for (const method of [r.method].flat()) if (method !== "HEAD") routes.push({ method, url: r.url });
});
await registerAdminRoutes(app, () => manager);
await app.ready();

const member = await users.createUser("guard-user@example.com", "password1", "user");
const memberCookie = { cookie: `${SESSION_COOKIE}=${sessions.createSession(member.id).rawToken}` };
const memberKey = { "x-api-key": apiKeys.createApiKey(member.id, "cli").key };
const extensionToken = { "x-api-key": apiKeys.createExtensionToken(member.id, "Laptop", "token").token };

const callers = [
  { who: "anonymous", headers: {}, status: 401 },
  { who: "a user (session)", headers: memberCookie, status: 403 },
  { who: "a user (API key)", headers: memberKey, status: 403 },
  { who: "an extension token", headers: extensionToken, status: 403 },
];

describe("admin boundary", () => {
  it("registers every admin route under /api/admin", () => {
    expect(routes.length).toBeGreaterThan(20);
    for (const r of routes) expect(r.url.startsWith(`${ADMIN_PREFIX}/`)).toBe(true);
  });

  // index.ts refuses these while shutting down by matching `${method} ${routeOptions.url}`, which includes the prefix.
  it("keeps the full URLs the shutdown guard matches on", () => {
    expect(routes).toEqual(expect.arrayContaining([{ method: "POST", url: "/api/admin/browsers/capacity" }, { method: "POST", url: "/api/admin/burst/image" }]));
  });

  it.each(callers)("refuses $who on every admin route", async ({ headers, status }) => {
    for (const r of routes) {
      const url = r.url.replace(/:\w+/g, "1");
      const res = await app.inject({ method: r.method as "GET", url, headers, payload: r.method === "GET" || r.method === "DELETE" ? undefined : {} });
      expect(res.statusCode, `${r.method} ${url}`).toBe(status);
    }
  });

  it("checks admin rights only in the admin scope's hook", () => {
    const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const offenders = fs
      .readdirSync(src, { recursive: true, encoding: "utf8" })
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
      .filter((f) => !["admin/routes.ts", "auth/plugin.ts"].includes(f.split(path.sep).join("/")))
      .filter((f) => /\brequireAdmin\b/.test(fs.readFileSync(path.join(src, f), "utf8")));
    expect(offenders).toEqual([]);
  });
});
