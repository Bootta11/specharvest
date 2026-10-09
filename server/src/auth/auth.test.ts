import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// config.ts reads DATA_DIR at import time — point it at a throwaway dir first.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "specharvest-auth-"));
process.env.DATA_DIR = dataDir;
const db = await import("../db/sqlite.ts");
const { hashPassword, hashToken, verifyPassword } = await import("./crypto.ts");
const users = await import("./users.ts");
const sessions = await import("./sessions.ts");
const apiKeys = await import("./api-keys.ts");
const { assertReadable, assertWritable, requireCollection } = await import("./ownership.ts");
const { buildCandidateQuery } = await import("../search/filters.ts");

afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }));

describe("passwords", () => {
  it("verifies the right password only, with a fresh salt each time", async () => {
    const a = await hashPassword("correct horse");
    const b = await hashPassword("correct horse");
    expect(a).not.toBe(b);
    expect(a.startsWith("scrypt$")).toBe(true);
    expect(await verifyPassword("correct horse", a)).toBe(true);
    expect(await verifyPassword("wrong horse", a)).toBe(false);
    expect(await verifyPassword("x", "garbage")).toBe(false);
  });
});

describe("users & sessions", () => {
  it("logs in case-insensitively and rejects duplicates, wrong passwords and disabled users", async () => {
    const u = await users.createUser("Ann@Example.com", "password1");
    expect(u.email).toBe("ann@example.com");
    await expect(users.createUser("ann@example.com", "password2")).rejects.toMatchObject({ statusCode: 409 });
    expect((await users.verifyLogin("ANN@example.com", "password1"))?.id).toBe(u.id);
    expect(await users.verifyLogin("ann@example.com", "nope")).toBeNull();
    expect(await users.verifyLogin("nobody@example.com", "password1")).toBeNull();
    users.setUserDisabled(u.id, true);
    expect(await users.verifyLogin("ann@example.com", "password1")).toBeNull();
    users.setUserDisabled(u.id, false);
  });

  it("slides expiry, and rejects expired, revoked and disabled sessions", async () => {
    const u = await users.createUser("sid@example.com", "password1");
    const { rawToken, expiresAt } = sessions.createSession(u.id);
    expect(sessions.verifySession(rawToken)).toBe(u.id);
    expect(sessions.verifySession("shs_unknown")).toBeNull();

    // Used again 10 days later → expiry moves out to 30 days from then.
    const later = Date.now() + 10 * 86_400_000;
    expect(sessions.verifySession(rawToken, later)).toBe(u.id);
    const pastFirstExpiry = expiresAt + 86_400_000;
    expect(sessions.verifySession(rawToken, pastFirstExpiry)).toBe(u.id);
    // Unused for longer than the TTL → expired.
    expect(sessions.verifySession(rawToken, pastFirstExpiry + sessions.SESSION_TTL_MS + 1)).toBeNull();

    users.setUserDisabled(u.id, true);
    expect(sessions.verifySession(rawToken)).toBeNull();
    users.setUserDisabled(u.id, false);
    // Disabling revoked it for good.
    expect(sessions.verifySession(rawToken)).toBeNull();

    const s2 = sessions.createSession(u.id);
    sessions.revokeSession(s2.rawToken);
    expect(sessions.verifySession(s2.rawToken)).toBeNull();
  });

  it("changing the password needs the current one and signs out other sessions", async () => {
    const u = await users.createUser("pat@example.com", "password1");
    const mine = sessions.createSession(u.id);
    const other = sessions.createSession(u.id);
    await expect(users.updateOwnAccount(u.id, { currentPassword: "bad", newPassword: "password2" })).rejects.toMatchObject({ statusCode: 401 });
    await users.updateOwnAccount(u.id, { currentPassword: "password1", newPassword: "password2" }, hashToken(mine.rawToken));
    expect(sessions.verifySession(mine.rawToken)).toBe(u.id);
    expect(sessions.verifySession(other.rawToken)).toBeNull();
    expect(await users.verifyLogin("pat@example.com", "password2")).not.toBeNull();
    await expect(users.updateOwnAccount(u.id, { currentPassword: "password2", email: "ann@example.com" })).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe("API keys", () => {
  it("works until revoked, only by its owner", async () => {
    const u = await users.createUser("key@example.com", "password1");
    const k = apiKeys.createApiKey(u.id, "script");
    expect(k.key.startsWith(k.keyPrefix)).toBe(true);
    expect(apiKeys.verifyApiKey(k.key)).toBe(u.id);
    expect(apiKeys.listApiKeys(u.id)[0]).toMatchObject({ id: k.id, label: "script" });
    expect(apiKeys.listApiKeys(u.id)[0].lastUsedAt).not.toBeNull();
    expect(apiKeys.revokeApiKey(u.id + 1000, k.id)).toBe(false);
    expect(apiKeys.revokeApiKey(u.id, k.id)).toBe(true);
    expect(apiKeys.verifyApiKey(k.key)).toBeNull();
    expect(apiKeys.listApiKeys(u.id)).toEqual([]);
  });
});

describe("ownership & scoping", () => {
  const admin = { id: 0, role: "admin" as const };

  it("own and shared collections are readable; only own are writable", async () => {
    const alice = { id: (await users.createUser("alice@example.com", "password1")).id, role: "user" as const };
    const bob = { id: (await users.createUser("bob@example.com", "password1")).id, role: "user" as const };
    const priv = db.createCollection("alice private", "https://shop.example/p", "shop.example", alice.id);
    const shared = db.createCollection("alice shared", "https://shop.example/s", "shop.example", alice.id);
    db.setCollectionShared(shared, true);
    const mine = db.createCollection("bob", "https://shop.example/b", "shop.example", bob.id);

    expect(db.listCollections(bob).map((c) => c.name)).toEqual(expect.arrayContaining(["alice shared", "bob"]));
    expect(db.listCollections(bob).map((c) => c.name)).not.toContain("alice private");
    expect(db.listCollections(bob).find((c) => c.id === shared)).toMatchObject({ canEdit: false, isShared: true, ownerEmail: "alice@example.com" });
    expect(db.listCollections(bob).find((c) => c.id === mine)?.canEdit).toBe(true);
    expect(db.listCollections(admin).find((c) => c.id === priv)?.canEdit).toBe(true);

    expect(() => requireCollection(priv, bob, "read")).toThrow("Not found");
    expect(requireCollection(shared, bob, "read").id).toBe(shared);
    expect(() => requireCollection(shared, bob, "write")).toThrow("Only the owner");
    expect(requireCollection(priv, admin, "write").id).toBe(priv);
    expect(() => assertReadable({ ownerId: alice.id, isShared: false }, bob)).toThrow();
    expect(() => assertWritable({ ownerId: bob.id, isShared: false }, bob)).not.toThrow();

    expect([...(db.readableScope(bob) as number[])].sort()).toEqual([shared, mine].sort());
    expect(db.readableScope(admin)).toBeNull();
    // Re-crawling someone else's URL doesn't reuse their collection.
    expect(db.findCollectionByUrl("https://shop.example/s", bob.id)).toBeNull();
    expect(db.findCollectionByUrl("https://shop.example/s", alice.id)?.id).toBe(shared);
  });

  it("jobs and spend are per user", async () => {
    const carol = { id: (await users.createUser("carol@example.com", "password1")).id, role: "user" as const };
    const dave = { id: (await users.createUser("dave@example.com", "password1")).id, role: "user" as const };
    const c = db.createCollection("carol", "https://shop.example/c", "shop.example", carol.id);
    const job = db.createJob("crawl", c, {}, carol.id);
    db.recordLlmUsage({ purpose: "extract", provider: "openrouter", model: "m", funding: "platform", promptTokens: 1, completionTokens: 1, cost: 0.5, webSearches: 0, jobId: job.id, collectionId: c, userId: carol.id });

    expect(db.listJobs(30, carol).map((j) => j.id)).toContain(job.id);
    expect(db.listJobs(30, dave).map((j) => j.id)).not.toContain(job.id);
    expect(db.listActiveJobs(dave)).toEqual([]);
    expect(db.canSeeJob(job, dave)).toBe(false);
    expect(db.canSeeJob(job, admin)).toBe(true);
    expect(db.usageSummary(Date.now(), carol.id).allTime).toBeCloseTo(0.5);
    expect(db.usageSummary(Date.now(), dave.id).allTime).toBe(0);
  });

  it("candidate queries honour a set of readable collections", () => {
    expect(buildCandidateQuery([], [], [3, 5]).sql).toContain("collection_id IN (?,?)");
    expect(buildCandidateQuery([], [], [3, 5]).params.slice(0, 2)).toEqual([3, 5]);
    expect(buildCandidateQuery([], [], []).sql).toMatch(/WHERE 0/);
    expect(buildCandidateQuery([], [], null).sql).not.toContain("collection_id");
  });

  it("hands data from before users existed to the first admin", async () => {
    const legacy = db.createCollection("legacy", "https://shop.example/legacy", "shop.example");
    const job = db.createJob("crawl", legacy);
    db.setSetting("notifications", { ntfy: { enabled: true, topic: "old" } });
    const root = await users.createUser("root@example.com", "password1", "admin");
    expect(db.assignOrphansTo(root.id)).toBeGreaterThanOrEqual(1);
    expect(db.getCollection(legacy)?.ownerId).toBe(root.id);
    expect(db.getJob(job.id)?.userId).toBe(root.id);
    expect(db.getSetting("notifications")).toBeNull();
    expect(db.getSetting(`notifications:${root.id}`)).toMatchObject({ ntfy: { topic: "old" } });
  });
});

describe("HTTP hardening", async () => {
  const { default: Fastify } = await import("fastify");
  const { registerAuth, SESSION_COOKIE } = await import("./plugin.ts");
  const { registerSecurityHeaders } = await import("../lib/security-headers.ts");
  const { errorHandler, httpError } = await import("../lib/http-error.ts");

  const app = Fastify({ trustProxy: "loopback,linklocal,uniquelocal" });
  await registerAuth(app);
  registerSecurityHeaders(app);
  app.setErrorHandler(errorHandler);
  app.post("/api/thing", async () => ({ ok: true }));
  app.post("/api/auth/login", async () => ({ ok: true }));
  app.get("/api/boom", async () => {
    throw new Error("SQLITE_ERROR near /data/specharvest.db");
  });
  app.get("/api/conflict", async () => {
    throw httpError(409, "Already running");
  });
  app.get("/api/health", async (req) => ({ ip: req.ip }));
  await app.ready();

  const u = await users.createUser("web@example.com", "password1");
  const cookie = `${SESSION_COOKIE}=${sessions.createSession(u.id).rawToken}`;
  const key = apiKeys.createApiKey(u.id, "script").key;
  const post = (url: string, headers: Record<string, string>) => app.inject({ method: "POST", url, headers: { host: "app.example", ...headers }, payload: {} });

  it("refuses cookie-authenticated writes from another site", async () => {
    expect((await post("/api/thing", { cookie, "sec-fetch-site": "cross-site" })).statusCode).toBe(403);
    expect((await post("/api/thing", { cookie, "sec-fetch-site": "same-site" })).statusCode).toBe(403);
    expect((await post("/api/thing", { cookie, origin: "https://evil.example" })).statusCode).toBe(403);
    // Sign-in is guarded too (login CSRF), with or without a session.
    expect((await post("/api/auth/login", { "sec-fetch-site": "cross-site" })).statusCode).toBe(403);
  });

  it("lets the app itself, scripts and API keys through", async () => {
    expect((await post("/api/thing", { cookie, "sec-fetch-site": "same-origin" })).statusCode).toBe(200);
    expect((await post("/api/thing", { cookie, origin: "http://app.example" })).statusCode).toBe(200);
    expect((await post("/api/thing", { cookie })).statusCode).toBe(200);
    expect((await post("/api/thing", { "x-api-key": key, "sec-fetch-site": "cross-site" })).statusCode).toBe(200);
  });

  it("sets security headers and keeps API responses out of caches", async () => {
    const res = await app.inject({ method: "GET", url: "/api/health" });
    expect(res.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(res.headers["content-security-policy"]).toContain("script-src 'self'");
    expect(res.headers).toMatchObject({ "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "x-frame-options": "DENY", "cache-control": "no-store" });
  });

  it("hides internal errors but keeps deliberate ones", async () => {
    const boom = await app.inject({ method: "GET", url: "/api/boom", headers: { cookie } });
    expect(boom.statusCode).toBe(500);
    expect(boom.json()).toEqual({ error: "Internal error" });
    const conflict = await app.inject({ method: "GET", url: "/api/conflict", headers: { cookie } });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toEqual({ error: "Already running" });
  });

  it("takes the client IP from trusted proxies only", async () => {
    // Behind a local proxy: the address it appended counts, whatever the client claimed before it.
    const viaProxy = await app.inject({ method: "GET", url: "/api/health", remoteAddress: "127.0.0.1", headers: { "x-forwarded-for": "1.2.3.4, 198.51.100.7" } });
    expect(viaProxy.json().ip).toBe("198.51.100.7");
    // Straight from the internet: X-Forwarded-For is ignored.
    const direct = await app.inject({ method: "GET", url: "/api/health", remoteAddress: "203.0.113.9", headers: { "x-forwarded-for": "1.2.3.4" } });
    expect(direct.json().ip).toBe("203.0.113.9");
  });
});

describe("search rate limits", async () => {
  const { default: Fastify } = await import("fastify");
  const { registerAuth, searchLimit, SESSION_COOKIE } = await import("./plugin.ts");
  const { errorHandler } = await import("../lib/http-error.ts");

  const app = Fastify();
  await registerAuth(app);
  app.setErrorHandler(errorHandler);
  app.post("/api/search", searchLimit({ typed: 2, filterOnly: 3 }), async () => ({ ok: true }));
  await app.ready();

  const u = await users.createUser("limits@example.com", "password1");
  const cookie = `${SESSION_COOKIE}=${sessions.createSession(u.id).rawToken}`;
  const search = (payload: object) => app.inject({ method: "POST", url: "/api/search", headers: { cookie }, payload });

  it("limits typed requests and filter-only searches separately", async () => {
    expect((await search({ query: "diesel" })).statusCode).toBe(200);
    expect((await search({ query: "cheap" })).statusCode).toBe(200);
    const limited = await search({ query: "red" });
    expect(limited.statusCode).toBe(429);
    expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
    expect(limited.json().error).toMatch(/rate limit/i);

    // A blank query is a filter-only search: its own bucket, still open.
    for (const body of [{ filters: [] }, { query: "  " }, { plan: { filters: [] } }]) expect((await search(body)).statusCode).toBe(200);
    expect((await search({})).statusCode).toBe(429);
  });
});
