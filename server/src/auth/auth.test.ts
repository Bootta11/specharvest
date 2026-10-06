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
    db.recordLlmUsage({ purpose: "extract", model: "m", promptTokens: 1, completionTokens: 1, cost: 0.5, webSearches: 0, jobId: job.id, collectionId: c, userId: carol.id });

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
