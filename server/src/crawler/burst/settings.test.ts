import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "specharvest-burst-settings-"));
process.env.DATA_DIR = dataDir;
process.env.BURST_PROVIDER = "digitalocean";
process.env.BURST_DO_TOKEN = "env-token-1234";
process.env.BURST_ALLOWED_IP = "198.51.100.1";

const db = await import("../../db/sqlite.ts");
const { env } = await import("../../config.ts");
const { effectiveBurstSettings, envBurstSettings, getBurstImage, publicBurstAccount, resolvedBurstAccount, saveBurstAccount, saveBurstImage, saveBurstSettings } = await import("./settings.ts");

afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }));
beforeEach(() => {
  for (const key of ["burst", "burst_account", "burst_image"]) db.deleteSetting(key);
});

describe("burst settings", () => {
  it("uses env defaults, stores only overrides, and resets with null", () => {
    expect(effectiveBurstSettings()).toEqual(envBurstSettings());
    expect(saveBurstSettings({ maxServers: 3 }).maxServers).toBe(3);
    expect(db.getSetting("burst")).toEqual({ maxServers: 3 });
    expect(saveBurstSettings({ maxServers: null }).maxServers).toBe(env.BURST_MAX_SERVERS);
    expect(db.getSetting("burst")).toBeNull();
  });

  it("rejects out-of-range settings", () => {
    expect(() => saveBurstSettings({ maxServers: 0 })).toThrow();
    expect(() => saveBurstSettings({ maxMinutes: 9 })).toThrow();
  });

  it("prefers the app-built image", () => {
    expect(getBurstImage()).toBeNull();
    saveBurstImage({ id: "123", name: "test-browser", createdAt: "2026-10-14T00:00:00Z" });
    expect(getBurstImage()?.id).toBe("123");
  });

  it("encrypts an app token and never returns its value", () => {
    saveBurstAccount({ token: "app-secret-9876" });
    const raw = db.getSetting<{ tokenEnc: string }>("burst_account")!;
    expect(raw.tokenEnc).not.toContain("app-secret");
    expect(publicBurstAccount().token).toEqual({ set: true, last4: "9876", source: "app" });
    expect(resolvedBurstAccount().token.value).toBe("app-secret-9876");
    saveBurstAccount({ token: null });
    expect(resolvedBurstAccount().token).toMatchObject({ value: "env-token-1234", source: "env" });
  });

  it("is available from either app or env account values", () => {
    saveBurstAccount({ allowedIp: "203.0.113.8", region: "ams3", size: "s-2vcpu-4gb" });
    expect(publicBurstAccount()).toMatchObject({
      allowedIp: "203.0.113.8",
      region: "ams3",
      size: "s-2vcpu-4gb",
      sources: { allowedIp: "app", region: "app", size: "app" },
    });
  });
});
