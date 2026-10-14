import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "specharvest-browsers-routes-"));
process.env.DATA_DIR = dataDir;
delete process.env.PUPPETEER_WS_ENDPOINT;

const testBrowserConnection = vi.fn(async (_url: string, _creds: unknown) => "Chrome/140.0");
vi.mock("./browser.ts", () => ({
  envBrowserEndpoints: () => [],
  testBrowserConnection,
  browserFleet: { defaultTabs: () => 2, get: () => null, addConfigured: vi.fn(), removeConfigured: vi.fn(async () => {}), envBrowser: () => null },
}));

// The capacity test without a browser: start() records the target, stop() ends it.
let capacityRunning: string | null = null;
const startCapacity = vi.fn((target: { name: string }) => {
  capacityRunning = target.name;
  return { browser: target.name, running: true };
});
vi.mock("./capacity.ts", async (original) => ({
  ...(await original<typeof import("./capacity.ts")>()),
  capacityTester: () => ({
    busyWith: () => capacityRunning,
    state: () => (capacityRunning ? { browser: capacityRunning, running: true } : null),
    start: (target: { name: string }) => {
      if (capacityRunning) throw Object.assign(new Error("already running"), { statusCode: 409 });
      return startCapacity(target);
    },
    stop: () => void (capacityRunning = null),
  }),
}));

const { default: Fastify } = await import("fastify");
const { registerAuth, SESSION_COOKIE } = await import("../auth/plugin.ts");
const users = await import("../auth/users.ts");
const sessions = await import("../auth/sessions.ts");
const { errorHandler } = await import("../lib/http-error.ts");
const { registerBrowserRoutes } = await import("./browsers-routes.ts");

afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }));

const app = Fastify();
await registerAuth(app);
app.setErrorHandler(errorHandler);
registerBrowserRoutes(app);
await app.ready();

const admin = await users.createUser("browsers-admin@example.com", "password1", "admin");
const member = await users.createUser("browsers-user@example.com", "password1", "user");
const cookie = (id: number) => ({ cookie: `${SESSION_COOKIE}=${sessions.createSession(id).rawToken}` });

describe("browser admin routes", () => {
  it("is admin-only", async () => {
    expect((await app.inject({ method: "GET", url: "/api/admin/browsers", headers: cookie(member.id) })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/api/admin/browsers/test", headers: cookie(member.id), payload: { url: "wss://x.example.com" } })).statusCode).toBe(403);
  });

  it("creates, edits and deletes a browser without returning its keys", async () => {
    const created = await app.inject({ method: "POST", url: "/api/admin/browsers", headers: cookie(admin.id), payload: { name: "b1", url: "wss://b1.example.com", apiKey: "top-secret-key" } });
    expect(created.statusCode).toBe(201);
    expect(created.body).not.toContain("top-secret-key");
    const [b1] = created.json();
    expect(b1).toMatchObject({ name: "b1", source: "app", apiKey: { set: true, last4: "-key" } });

    const updated = await app.inject({ method: "PUT", url: `/api/admin/browsers/${b1.id}`, headers: cookie(admin.id), payload: { tabs: 5 } });
    expect(updated.json()[0]).toMatchObject({ tabs: 5, apiKey: { set: true } });

    expect((await app.inject({ method: "PUT", url: "/api/admin/browsers/999", headers: cookie(admin.id), payload: { tabs: 1 } })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: "/api/admin/browsers", headers: cookie(admin.id), payload: { name: "b1", url: "wss://other.example.com" } })).statusCode).toBe(409);

    const deleted = await app.inject({ method: "DELETE", url: `/api/admin/browsers/${b1.id}`, headers: cookie(admin.id) });
    expect(deleted.json()).toEqual([]);
  });

  it("tests a saved browser with its saved keys unless new ones are typed", async () => {
    const [b] = (
      await app.inject({ method: "POST", url: "/api/admin/browsers", headers: cookie(admin.id), payload: { name: "b2", url: "wss://b2.example.com", apiKey: "saved-key", username: "u" } })
    ).json();
    const test = (payload: Record<string, unknown>) => app.inject({ method: "POST", url: "/api/admin/browsers/test", headers: cookie(admin.id), payload });

    expect((await test({ id: b.id })).json()).toEqual({ ok: true, version: "Chrome/140.0" });
    expect(testBrowserConnection).toHaveBeenLastCalledWith("wss://b2.example.com", { apiKey: "saved-key", username: "u", password: null });

    await test({ id: b.id, apiKey: "typed-key" });
    expect(testBrowserConnection).toHaveBeenLastCalledWith("wss://b2.example.com", { apiKey: "typed-key", username: "u", password: null });

    testBrowserConnection.mockRejectedValueOnce(new Error("Unexpected server response: 401"));
    expect((await test({ url: "wss://new.example.com" })).json()).toEqual({ ok: false, error: "Unexpected server response: 401" });
    expect((await test({ url: "https://new.example.com" })).statusCode).toBe(400);
  });

  it("starts, guards and stops a capacity test", async () => {
    const list = (await app.inject({ method: "POST", url: "/api/admin/browsers", headers: cookie(admin.id), payload: { name: "cap", url: "wss://cap.example.com", apiKey: "cap-key" } })).json();
    const b = list.find((x: { name: string }) => x.name === "cap");
    const start = (name: string, id = admin.id) => app.inject({ method: "POST", url: "/api/admin/browsers/capacity", headers: cookie(id), payload: { name } });

    expect((await start("cap", member.id)).statusCode).toBe(403);
    expect((await start("nope")).statusCode).toBe(404);
    const started = await start("cap");
    expect(started.statusCode).toBe(202);
    expect(startCapacity).toHaveBeenLastCalledWith({ name: "cap", id: b.id, url: "wss://cap.example.com", creds: { apiKey: "cap-key", username: null, password: null } });
    expect((await start("cap")).statusCode).toBe(409);

    // The browser under test can't be changed or deleted meanwhile.
    expect((await app.inject({ method: "PUT", url: `/api/admin/browsers/${b.id}`, headers: cookie(admin.id), payload: { tabs: 3 } })).statusCode).toBe(409);
    expect((await app.inject({ method: "DELETE", url: `/api/admin/browsers/${b.id}`, headers: cookie(admin.id) })).statusCode).toBe(409);
    expect((await app.inject({ method: "GET", url: "/api/admin/browsers/capacity", headers: cookie(admin.id) })).json()).toEqual({ run: { browser: "cap", running: true } });

    expect((await app.inject({ method: "DELETE", url: "/api/admin/browsers/capacity", headers: cookie(admin.id) })).json()).toEqual({ run: null });
    expect((await app.inject({ method: "PUT", url: `/api/admin/browsers/${b.id}`, headers: cookie(admin.id), payload: { tabs: 3 } })).statusCode).toBe(200);
  });
});
