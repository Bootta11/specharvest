import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// config.ts reads DATA_DIR at import time — point it at a throwaway dir first.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "specharvest-manual-"));
process.env.DATA_DIR = dataDir;
const db = await import("./sqlite.ts");

afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }));

const addItem = (collectionId: number, url: string, manual?: boolean) =>
  db.upsertItem({ collectionId, url, title: url, price: null, currency: null, mainImage: null, description: null, identity: null, specs: {}, rawText: null, manual });

describe("hand-added items", () => {
  const bikes = db.createCollection("Bikes", "https://a.example/bikes", "a.example");
  addItem(bikes, "https://a.example/1");
  addItem(bikes, "https://a.example/2");
  addItem(bikes, "https://b.example/ad/9", true);

  it("are counted and never marked gone by a listing walk", () => {
    expect(db.getCollection(bikes)).toMatchObject({ kind: "listing", itemCount: 3, manualCount: 1 });
    expect(db.markGone(bikes, ["https://a.example/1"])).toBe(1);
    expect(db.getItemFingerprints(bikes).get("https://b.example/ad/9")).toMatchObject({ manual: true, goneAt: null });
  });

  it("stay hand-added when a listing crawl re-extracts them", () => {
    addItem(bikes, "https://b.example/ad/9");
    expect(db.getItemFingerprints(bikes).get("https://b.example/ad/9")?.manual).toBe(true);
    db.setItemManual(bikes, "https://a.example/1");
    expect(db.getCollection(bikes)?.manualCount).toBe(2);
  });

  it("a collection started from an item page keeps its kind through export/import", () => {
    const one = db.createCollection("Ads", "https://b.example/ad/1", "b.example", null, "items");
    addItem(one, "https://b.example/ad/1", true);
    const exported = db.exportCollection(one);
    expect(exported.collection.kind).toBe("items");
    expect(exported.items[0].manual).toBe(true);
    const me = Number(db.getDb().prepare("INSERT INTO users (email, password_hash, role, created_at) VALUES ('me@example.com', 'x', 'user', ?)").run(Date.now()).lastInsertRowid);
    const { collectionId } = db.importCollection(exported, { id: me, role: "user" });
    expect(db.getCollection(collectionId)).toMatchObject({ kind: "items", manualCount: 1 });
  });
});
