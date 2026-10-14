import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { BurstManager } from "./index.ts";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "specharvest-burst-routes-"));
process.env.DATA_DIR = dataDir;
process.env.BURST_PROVIDER = "digitalocean";
delete process.env.BURST_DO_TOKEN;
delete process.env.BURST_ALLOWED_IP;

const { default: Fastify } = await import("fastify");
const { registerAuth, SESSION_COOKIE } = await import("../../auth/plugin.ts");
const users = await import("../../auth/users.ts");
const sessions = await import("../../auth/sessions.ts");
const { errorHandler } = await import("../../lib/http-error.ts");
const { registerBurstRoutes } = await import("./routes.ts");

afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }));

const build = { running: false, startedAt: null, steps: [], lastError: null, lastFinishedAt: null };
let busy = false;
const manager = {
  provider: () => null,
  controller: () => null,
  refresh: vi.fn(),
  busy: () => busy,
  imageBuilds: { state: () => build, start: () => false, recover: async () => {}, check: () => false, close: async () => {} },
  close: async () => {},
} as unknown as BurstManager;

const app = Fastify();
await registerAuth(app);
app.setErrorHandler(errorHandler);
registerBurstRoutes(app, () => manager);
await app.ready();

const admin = await users.createUser("burst-admin@example.com", "password1", "admin");
const member = await users.createUser("burst-user@example.com", "password1", "user");
const cookie = (id: number) => ({ cookie: `${SESSION_COOKIE}=${sessions.createSession(id).rawToken}` });

describe("burst admin routes", () => {
  it("is admin-only and returns the status shape", async () => {
    expect((await app.inject({ method: "GET", url: "/api/admin/burst", headers: cookie(member.id) })).statusCode).toBe(403);
    const response = await app.inject({ method: "GET", url: "/api/admin/burst", headers: cookie(admin.id) });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ providerEnabled: true, available: false, running: [], history: [], settings: { enabled: false } });
  });

  it("updates and resets a setting", async () => {
    const put = (payload: Record<string, unknown>) => app.inject({ method: "PUT", url: "/api/admin/burst", headers: cookie(admin.id), payload });
    expect((await put({ maxServers: 4 })).json()).toMatchObject({ settings: { maxServers: 4 }, overridden: ["maxServers"] });
    expect((await put({ maxServers: null })).json()).toMatchObject({ settings: { maxServers: 1 }, overridden: [] });
  });

  it("refuses account changes while a server or build is active", async () => {
    busy = true;
    const response = await app.inject({ method: "PUT", url: "/api/admin/burst/account", headers: cookie(admin.id), payload: { region: "ams3" } });
    busy = false;
    expect(response.statusCode).toBe(409);
  });

  it("refuses an image build until setup is complete", async () => {
    const response = await app.inject({ method: "POST", url: "/api/admin/burst/image", headers: cookie(admin.id) });
    expect(response.statusCode).toBe(409);
  });
});
