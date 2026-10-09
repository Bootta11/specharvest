import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

// config.ts reads env at import time — throwaway DATA_DIR, the web app's own origin.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "specharvest-app-auth-"));
process.env.DATA_DIR = dataDir;
process.env.PUBLIC_URL = "https://specharvest.example";
const { registerAuth, currentUser } = await import("./plugin.ts");
const { registerAuthRoutes } = await import("./routes.ts");
const users = await import("./users.ts");

const APP_ORIGIN = "https://localhost";
let app: FastifyInstance;

beforeAll(async () => {
  await users.createUser("phone@example.com", "password1");
  app = Fastify();
  await registerAuth(app);
  registerAuthRoutes(app);
  app.get("/api/whoami", async (req) => ({ email: currentUser(req).email }));
  await app.ready();
});
afterAll(async () => {
  await app.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const login = (headers: Record<string, string>) =>
  app.inject({ method: "POST", url: "/api/auth/login", headers: { "content-type": "application/json", ...headers }, payload: { email: "phone@example.com", password: "password1" } });

describe("Android app sign-in (bearer token)", () => {
  it("returns a token instead of a cookie, even from the app's cross-site origin", async () => {
    const res = await login({ origin: APP_ORIGIN, "sec-fetch-site": "cross-site", "x-specharvest-client": "app" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["set-cookie"]).toBeUndefined();
    const body = res.json() as { user: { email: string }; token: string };
    expect(body.user.email).toBe("phone@example.com");
    expect(body.token).toMatch(/^shs_/);
    expect(res.headers["access-control-allow-origin"]).toBe(APP_ORIGIN);
  });

  it("still refuses a cross-site cookie login", async () => {
    const res = await login({ origin: "https://evil.example", "sec-fetch-site": "cross-site" });
    expect(res.statusCode).toBe(403);
  });

  it("authenticates with the bearer token until logout revokes it", async () => {
    const { token } = (await login({ "x-specharvest-client": "app" })).json() as { token: string };
    const auth = { authorization: `Bearer ${token}`, origin: APP_ORIGIN };
    const me = await app.inject({ method: "GET", url: "/api/whoami", headers: auth });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toEqual({ email: "phone@example.com" });

    const out = await app.inject({ method: "POST", url: "/api/auth/logout", headers: { ...auth, "sec-fetch-site": "cross-site" } });
    expect(out.statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: "/api/whoami", headers: auth })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/whoami", headers: { authorization: "Bearer shs_nope" } })).statusCode).toBe(401);
  });

  it("answers CORS preflight for the app's origin only", async () => {
    const preflight = (origin: string) =>
      app.inject({
        method: "OPTIONS",
        url: "/api/whoami",
        headers: { origin, "access-control-request-method": "GET", "access-control-request-headers": "authorization" },
      });
    const ok = await preflight(APP_ORIGIN);
    expect(ok.statusCode).toBe(204);
    expect(ok.headers["access-control-allow-origin"]).toBe(APP_ORIGIN);
    expect(String(ok.headers["access-control-allow-headers"]).toLowerCase()).toContain("authorization");
    expect(ok.headers["access-control-allow-credentials"]).toBeUndefined();
    expect((await preflight("https://evil.example")).headers["access-control-allow-origin"]).toBeUndefined();
  });
});
