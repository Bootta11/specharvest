import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "specharvest-browsers-"));
process.env.DATA_DIR = dataDir;
process.env.PUPPETEER_WS_ENDPOINT = "wss://env-browser.example.com/abc";
process.env.PUPPETEER_WS_API_KEY = "env-key-9876";

// The pool, without real browsers.
const pool = new Map<string, { tabs: number | null; allowProxy: boolean; creds: Record<string, unknown> }>();
vi.mock("./browser.ts", () => ({
  envBrowserEndpoints: () => [{ name: "main", url: "wss://env-browser.example.com/abc" }],
  browserFleet: {
    defaultTabs: () => 2,
    get: (name: string) => (pool.has(name) ? { name, source: "static", active: 0, tabs: pool.get(name)!.tabs ?? 2, state: "up", idleSince: 0, pages: 0 } : null),
    addConfigured: vi.fn((name: string, _url: string, creds: Record<string, unknown>, opts: { tabs: number | null; allowProxy: boolean }) => {
      if (pool.has(name)) throw new Error(`Browser ${name} is already in the pool`);
      pool.set(name, { ...opts, creds });
    }),
    removeConfigured: vi.fn(async (name: string) => void pool.delete(name)),
  },
}));

const db = await import("../db/sqlite.ts");
const { resetMasterKey } = await import("../lib/secrets.ts");
const browsers = await import("./browsers.ts");

afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }));
beforeEach(async () => {
  for (const row of db.listBrowsers()) browsers.deleteBrowser(row.id);
  await browsers.settled();
});

describe("admin browsers", () => {
  it("stores keys encrypted, never returns them, and puts the browser in the pool with its own keys", async () => {
    const id = browsers.createBrowser({ name: "hetzner-1", url: "wss://b1.example.com", apiKey: "secret-key-1234", username: "u1", password: "pw-1", tabs: 4 });
    await browsers.settled();
    const row = db.getBrowser(id)!;
    expect(row.apiKeyEnc).not.toContain("secret-key");
    expect(row.passwordEnc).not.toContain("pw-1");
    expect(pool.get("hetzner-1")).toEqual({ tabs: 4, allowProxy: true, creds: { apiKey: "secret-key-1234", username: "u1", password: "pw-1" } });

    const list = browsers.listBrowserStatus();
    expect(JSON.stringify(list)).not.toMatch(/secret-key-1234|pw-1/);
    expect(list.map((b) => [b.name, b.source])).toEqual([
      ["main", "env"],
      ["hetzner-1", "app"],
    ]);
    expect(list[0]).toMatchObject({ id: null, host: "env-browser.example.com", url: null, apiKey: { set: true, last4: "9876" } });
    expect(list[1]).toMatchObject({ apiKey: { set: true, last4: "1234" }, password: { set: true }, tabs: 4, live: { state: "up", tabs: 4 } });
  });

  it("keeps, replaces and clears secrets; renames and switches off through the pool", async () => {
    const id = browsers.createBrowser({ name: "b2", url: "ws://b2.example.com:3000", apiKey: "key-aaaa", password: "pw" });
    await browsers.settled();
    browsers.updateBrowser(id, { tabs: 3 });
    await browsers.settled();
    expect(pool.get("b2")).toMatchObject({ tabs: 3, creds: { apiKey: "key-aaaa", password: "pw" } });

    browsers.updateBrowser(id, { name: "b2-renamed", apiKey: "key-bbbb", password: null });
    await browsers.settled();
    expect(pool.has("b2")).toBe(false);
    expect(pool.get("b2-renamed")).toMatchObject({ creds: { apiKey: "key-bbbb", password: null } });
    expect(db.getBrowser(id)).toMatchObject({ apiKeyLast4: "bbbb", passwordEnc: null });

    browsers.updateBrowser(id, { enabled: false });
    await browsers.settled();
    expect(pool.has("b2-renamed")).toBe(false);
    expect(browsers.listBrowserStatus().find((b) => b.id === id)).toMatchObject({ enabled: false, live: null });

    browsers.deleteBrowser(id);
    await browsers.settled();
    expect(db.getBrowser(id)).toBeNull();
  });

  it("rejects reserved, duplicate and invalid input", () => {
    expect(() => browsers.createBrowser({ name: "main-2", url: "wss://x.example.com" })).toThrow(/reserved/);
    expect(() => browsers.createBrowser({ name: "specharvest-burst-1", url: "wss://x.example.com" })).toThrow(/reserved/);
    expect(() => browsers.createBrowser({ name: "ok", url: "https://x.example.com" })).toThrow();
    expect(() => browsers.createBrowser({ name: "bad/name", url: "wss://x.example.com" })).toThrow();
    expect(() => browsers.createBrowser({ name: "   ", url: "wss://x.example.com" })).toThrow();
    expect(browsers.createBrowser({ name: "Hetzner Falkenstein 1", url: "wss://x2.example.com" })).toBeGreaterThan(0);
    browsers.createBrowser({ name: "dup", url: "wss://x.example.com" });
    expect(() => browsers.createBrowser({ name: "DUP", url: "wss://y.example.com" })).toThrow(/already exists/);
  });

  it("warns when a saved key can't be decrypted", async () => {
    browsers.createBrowser({ name: "b3", url: "wss://b3.example.com", apiKey: "key-cccc" });
    await browsers.settled();
    const keyFile = path.join(dataDir, "encryption.key");
    const saved = fs.readFileSync(keyFile);
    fs.writeFileSync(keyFile, Buffer.alloc(32, 7).toString("base64"));
    resetMasterKey();
    try {
      expect(browsers.listBrowserStatus().find((b) => b.name === "b3")!.apiKey).toMatchObject({ set: true, warning: expect.stringMatching(/enter it again/) });
    } finally {
      fs.writeFileSync(keyFile, saved);
      resetMasterKey();
    }
  });
});
