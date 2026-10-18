import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// config.ts reads DATA_DIR at import time — point it at a throwaway dir first.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "specharvest-pick-"));
process.env.DATA_DIR = dataDir;
const db = await import("../db/sqlite.ts");
const { pickItems, stopCrawl } = await import("./job.ts");

afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }));

/** A pick-first crawl parked with two walked cards. */
function parkedCrawl() {
  const c = db.createCollection("pick", "https://shop.example/list", "shop.example");
  const job = db.createJob("crawl", c, { url: "https://shop.example/list", pickItems: true });
  db.saveJobCandidates(
    job.id,
    ["a", "b"].map((id) => ({ url: `https://shop.example/i/${id}`, title: id, cardText: id, image: null })),
    false,
  );
  db.updateJob(job.id, { status: "picking", itemsFound: 2 });
  return job.id;
}

describe("picking items of a parked crawl", () => {
  it("refuses a job that isn't waiting for a pick", () => {
    const id = parkedCrawl();
    db.updateJob(id, { status: "done" });
    expect(() => pickItems(id, ["https://shop.example/i/a"])).toThrow(expect.objectContaining({ statusCode: 409 }));
  });

  it("refuses URLs the walk didn't find, and picks nothing then", () => {
    const id = parkedCrawl();
    expect(() => pickItems(id, ["https://shop.example/i/a", "https://elsewhere.example/x"])).toThrow(expect.objectContaining({ statusCode: 400 }));
    expect(db.pickedWalk(id)).toBeNull();
    expect(db.getJob(id)?.status).toBe("picking");
  });

  it("stopping a parked crawl discards its list; it can be resumed (walks again)", () => {
    const id = parkedCrawl();
    const job = stopCrawl(id)!;
    expect(job.status).toBe("stopped");
    expect(job.message).toBe("Discarded — nothing extracted");
    expect(job.resumable).toBe(true);
    expect(db.listJobCandidates(id)).toEqual([]);
  });
});
