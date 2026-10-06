import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

// config.ts reads DATA_DIR at import time — point it at a throwaway dir first.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "specharvest-jobs-"));
process.env.DATA_DIR = dataDir;
const db = await import("./sqlite.ts");

afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }));

const item = (collectionId: number, url: string) => ({
  collectionId,
  url,
  title: url,
  price: null,
  currency: null,
  mainImage: null,
  description: null,
  identity: null,
  specs: {},
  rawText: null,
});

describe("resumable crawl jobs", () => {
  it("is resumable only when a crawl with saved params is stopped or interrupted", () => {
    const c = db.createCollection("shop", "https://shop.example/a", "shop.example");
    const withParams = db.createJob("crawl", c, { url: "https://shop.example/a", mode: "quick" });
    const legacy = db.createJob("crawl", c);
    const enrich = db.createJob("enrich", c, {});

    expect(db.updateJob(withParams.id, { status: "running" }).resumable).toBe(false);
    expect(db.updateJob(withParams.id, { status: "stopped" }).resumable).toBe(true);
    expect(db.updateJob(withParams.id, { status: "done" }).resumable).toBe(false);
    expect(db.updateJob(legacy.id, { status: "stopped" }).resumable).toBe(false);
    expect(db.updateJob(enrich.id, { status: "stopped" }).resumable).toBe(false);
    expect(db.getJobParams(withParams.id)).toEqual({ url: "https://shop.example/a", mode: "quick" });
  });

  it("finds items handled since a job started", async () => {
    const c = db.createCollection("shop", "https://shop.example/b", "shop.example");
    db.upsertItem(item(c, "https://shop.example/old"));
    await new Promise((r) => setTimeout(r, 5));
    const since = Date.now();
    const fresh = db.upsertItem(item(c, "https://shop.example/new"));
    db.touchItem(db.getItemFingerprints(c).get("https://shop.example/old")!.id, {});
    db.upsertItem(item(c, "https://shop.example/extracted"));

    expect(fresh).toBeGreaterThan(0);
    expect([...db.urlsSeenSince(c, since)].sort()).toEqual(["https://shop.example/extracted", "https://shop.example/new", "https://shop.example/old"]);
    expect(db.urlsSeenSince(c, Date.now() + 1000).size).toBe(0);
  });

  it("marks crawls cut off by a restart as interrupted, others as failed", async () => {
    const c = db.createCollection("shop", "https://shop.example/c", "shop.example");
    const crawl = db.createJob("crawl", c, { url: "https://shop.example/c" });
    db.updateJob(crawl.id, { status: "running" });
    const legacy = db.createJob("crawl", c);
    const enrich = db.createJob("enrich", c);

    // A fresh module instance opens the DB again, like a server restart.
    vi.resetModules();
    const restarted = await import("./sqlite.ts");
    restarted.getDb();

    const after = (id: number) => restarted.getJob(id)!;
    expect(after(crawl.id)).toMatchObject({ status: "interrupted", resumable: true, error: "Interrupted by server restart" });
    expect(after(legacy.id)).toMatchObject({ status: "failed", resumable: false });
    expect(after(enrich.id)).toMatchObject({ status: "failed", resumable: false });
  });
});
