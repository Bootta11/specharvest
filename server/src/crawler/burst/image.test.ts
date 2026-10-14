import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { DigitalOceanProvider } from "./digitalocean.ts";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "specharvest-burst-image-"));
process.env.DATA_DIR = dataDir;
const { createImageBuilds } = await import("./image.ts");
const db = await import("../../db/sqlite.ts");

afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }));

const fakeProvider = (prepare: () => Promise<void>): DigitalOceanProvider => ({
  name: "fake",
  prepare: vi.fn(prepare),
  create: vi.fn(async () => ({ id: "1", name: "build", ip: "203.0.113.1", active: true, createdAt: Date.now() })),
  get: vi.fn(async () => null),
  delete: vi.fn(async () => {}),
  list: vi.fn(async () => []),
  hourlyPrice: vi.fn(async () => 0.07),
  powerOff: vi.fn(async () => {}),
  snapshot: vi.fn(async () => ({ id: "10", name: "image", createdAt: new Date().toISOString(), sizeGb: 2 })),
  listSnapshots: vi.fn(async () => []),
  deleteSnapshot: vi.fn(async () => {}),
  options: vi.fn(async () => ({ regions: [], sizes: [] })),
  testScopes: vi.fn(async () => ({})),
});

const config = () => ({ tag: "test-burst", prefix: "test-browser-", allowedIp: "198.51.100.1", autoRebuildDays: 7 });

describe("image builds", () => {
  it("allows only one build at a time", () => {
    const provider = fakeProvider(() => new Promise(() => {}));
    const builds = createImageBuilds(() => provider, config);
    expect(builds.start()).toBe(true);
    expect(builds.start()).toBe(false);
    expect(builds.state().running).toBe(true);
  });

  it("records a failed build and permits a later retry", async () => {
    const provider = fakeProvider(async () => {
      throw new Error("missing scope");
    });
    const builds = createImageBuilds(() => provider, config);
    expect(builds.start()).toBe(true);
    await new Promise((resolve) => setImmediate(resolve));
    expect(builds.state()).toMatchObject({ running: false, lastError: "missing scope" });
  });

  it("starts the first automatic image when none has been saved", () => {
    db.deleteSetting("burst_image_last_failure");
    db.deleteSetting("burst_image");
    const provider = fakeProvider(() => new Promise(() => {}));
    const builds = createImageBuilds(() => provider, config);
    expect(builds.check()).toBe(true);
  });
});
