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

describe("lookup stats", () => {
  it("round-trips the web lookup breakdown through the job row", () => {
    const job = db.createJob("enrich", null);
    expect(job.lookup).toBeNull();
    const lookup = {
      attributes: ["wheelbase"],
      listings: 194,
      products: 157,
      merged: 1,
      merges: [{ from: "golf life+ 2.0 tdi 2026", to: "golf life plus 2.0 tdi 2026" }],
      cached: 1,
      fromSiblings: 1,
      toLookUp: 3,
      remaining: 153,
    };
    expect(db.updateJob(job.id, { lookup, itemsRemaining: 153 }).lookup).toEqual(lookup);
    expect(db.getJob(job.id)?.itemsRemaining).toBe(153);
  });
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

  it("marks crawls cut off by a restart as interrupted, lookups as stopped, others as failed", async () => {
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
    expect(after(enrich.id)).toMatchObject({ status: "stopped", resumable: false });
  });
});

describe("crawls continued after a restart", () => {
  const candidates = (c: number) => db.listRestartCandidates().filter((r) => r.job.collectionId === c);

  it("lists interrupted crawls flagged to continue, with their crashes in a row", () => {
    const c = db.createCollection("shop", "https://shop.example/d", "shop.example");
    const crawl = () => db.createJob("crawl", c, { url: "https://shop.example/d" }).id;
    const flagged = crawl();
    db.setAutoResume(flagged, true);
    db.markPausedForRestart(flagged, "Paused");
    const stoppedByUser = crawl();
    db.setAutoResume(stoppedByUser, false);
    db.markPausedForRestart(stoppedByUser, "Paused");
    // Interrupted before the flag existed (or by hand): left alone.
    const historical = crawl();
    db.updateJob(historical, { status: "interrupted", error: db.RESTART_ERROR });
    const finished = crawl();
    db.setAutoResume(finished, true);
    db.updateJob(finished, { status: "done" });

    expect(candidates(c).map((r) => r.job.id)).toEqual([flagged]);
    expect(candidates(c)[0]).toMatchObject({ crashRestarts: 0, job: { status: "interrupted", message: "Paused", resumable: true } });
  });

  it("counts crashes on start, resets them on a clean pause or the user's resume", async () => {
    const c = db.createCollection("shop", "https://shop.example/e", "shop.example");
    const id = db.createJob("crawl", c, { url: "https://shop.example/e" }).id;
    const lookup = db.createJob("enrich", c).id;
    db.setAutoResume(id, true);
    db.updateJob(id, { status: "running" });
    db.updateJob(lookup, { status: "running", message: "Looking up wheelbase" });

    vi.resetModules();
    const restarted = await import("./sqlite.ts");
    restarted.getDb();
    expect(candidates(c)).toMatchObject([{ crashRestarts: 1, job: { id, status: "interrupted", error: db.RESTART_ERROR } }]);
    // A lookup keeps what it found and says why it stopped (not its last progress line).
    expect(restarted.getJob(lookup)).toMatchObject({ status: "stopped", message: db.LOOKUP_RESTART_MESSAGE });

    db.markPausedForRestart(id, "Paused");
    expect(candidates(c)[0].crashRestarts).toBe(0);
    db.updateJob(id, { status: "running" });
    vi.resetModules();
    (await import("./sqlite.ts")).getDb();
    expect(candidates(c)[0].crashRestarts).toBe(1);
    db.resetCrashRestarts(id);
    expect(candidates(c)[0].crashRestarts).toBe(0);
  });
});
