import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { collectionExportSchema, importRequestSchema } from "@specharvest/shared";

// config.ts reads DATA_DIR at import time — point it at a throwaway dir first.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "specharvest-export-"));
process.env.DATA_DIR = dataDir;
const db = await import("./sqlite.ts");

afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }));

const addUser = (email: string, role: "user" | "admin" = "user") =>
  Number(db.getDb().prepare("INSERT INTO users (email, password_hash, role, created_at) VALUES (?, 'x', ?, ?)").run(email, role, Date.now()).lastInsertRowid);

describe("collection export / import", () => {
  const owner = addUser("owner@example.com");
  const importerId = addUser("importer@example.com");
  const importer = { id: importerId, role: "user" as const };

  const sourceId = db.createCollection("Bikes", "https://shop.example/bikes", "shop.example", owner);
  db.saveDetection(sourceId, { listItemSelector: ".card", paginationType: "pages", nextSelector: "a.next" });
  const a = db.upsertItem({ collectionId: sourceId, url: "https://shop.example/a", title: "Bike A", price: 1000, currency: "EUR", mainImage: null, description: "fast", identity: "Bike A 2024", specs: { power_kw: 50 }, rawText: "raw a", contentHash: "h1", contentText: "text a" });
  db.upsertItem({ collectionId: sourceId, url: "https://shop.example/b", title: "Bike B", price: null, currency: null, mainImage: null, description: null, identity: "bike a 2024", specs: { power_kw: 40 }, rawText: null });
  db.upsertSpecKey(sourceId, { key: "power_kw", type: "number", unit: "kW", label: "Power", example: "50", origin: "page" });
  // A web lookup result: value on the item + its source + the global lookup cache.
  db.upsertSpecKey(sourceId, { key: "weight_kg", type: "number", unit: "kg", label: "Weight", example: "180", origin: "web" }, 0);
  db.setItemSpec(a, "weight_kg", 180, { origin: "web", sourceUrl: "https://maker.example/a", confidence: 0.9 });
  db.saveWebFact({ identity: "Bike A 2024", key: "weight_kg", value: 180, unit: "kg", sourceUrl: "https://maker.example/a", confidence: 0.9, found: true });
  db.mergeCanonical("bike a 2024", "Bike A 2024");

  db.setCollectionGrouping(sourceId, "loose");

  const exported = collectionExportSchema.parse(JSON.parse(JSON.stringify(db.exportCollection(sourceId))));

  it("exports items, web lookup sources, keys and the related cache rows", () => {
    expect(exported.items).toHaveLength(2);
    const itemA = exported.items.find((i) => i.url.endsWith("/a"))!;
    expect(itemA.specs).toEqual({ power_kw: 50, weight_kg: 180 });
    expect(itemA.sources.weight_kg).toEqual({ origin: "web", sourceUrl: "https://maker.example/a", confidence: 0.9 });
    expect(itemA.contentHash).toBe("h1");
    expect(exported.specKeys.map((k) => k.key).sort()).toEqual(["power_kw", "weight_kg"]);
    expect(exported.aliases).toContainEqual({ identity: "bike a 2024", canonical: "Bike A 2024" });
    expect(exported.webFacts).toContainEqual(expect.objectContaining({ identity: "Bike A 2024", key: "weight_kg", value: 180, found: true }));
    expect(exported.collection.detection).toMatchObject({ listItemSelector: ".card" });
  });

  it("reads files from before grouping modes as strict", () => {
    const { grouping: _drop, ...oldCollection } = exported.collection;
    expect(collectionExportSchema.parse({ ...exported, collection: oldCollection }).collection.grouping).toBe("strict");
  });

  it("imports as a new private collection of the importer", () => {
    const { collectionId, itemIds } = db.importCollection(exported, importer);
    expect(collectionId).not.toBe(sourceId);
    expect(itemIds).toHaveLength(2);
    const c = db.getCollection(collectionId, importer)!;
    expect(c).toMatchObject({ name: "Bikes", ownerId: importerId, isShared: false, canEdit: true, itemCount: 2, grouping: "loose" });
    expect(c.detection).toMatchObject({ paginationType: "pages" });

    const items = db.listItems(collectionId, 10);
    const itemA = items.find((i) => i.url.endsWith("/a"))!;
    expect(itemA.specs.weight_kg).toBe(180);
    expect(itemA.sources.weight_kg).toMatchObject({ origin: "web", confidence: 0.9 });
    expect(db.getItemFingerprints(collectionId).get("https://shop.example/a")?.contentHash).toBe("h1");

    const keys = db.listSpecKeys(collectionId);
    expect(keys.find((k) => k.key === "power_kw")?.count).toBe(2);
    expect(keys.find((k) => k.key === "weight_kg")).toMatchObject({ count: 1, origin: "web" });
  });

  it("renames on a name clash and never overwrites local grouping or lookups", () => {
    db.splitIdentity("bike a 2024"); // local decision: "bike a 2024" is its own product now
    db.saveWebFact({ identity: "Bike A 2024", key: "weight_kg", value: 175, unit: "kg", sourceUrl: null, confidence: 1, found: true });
    const { collectionId } = db.importCollection(exported, importer);
    expect(db.getCollection(collectionId)!.name).toBe("Bikes (imported)");
    expect(db.getCanonicalIdentity("bike a 2024")).toBe("bike a 2024");
    expect(db.getWebFact("Bike A 2024", "weight_kg")?.value).toBe(175);
  });

  it("exports every readable collection and imports the bundle", () => {
    const other = db.createCollection("Cars", "https://shop.example/cars", "shop.example", owner);
    db.upsertItem({ collectionId: other, url: "https://shop.example/car", title: "Car", price: 5000, currency: "EUR", mainImage: null, description: null, identity: null, specs: {}, rawText: null });
    const hidden = db.createCollection("Private", "https://elsewhere.example", "elsewhere.example", importerId);

    const bundle = importRequestSchema.parse(JSON.parse(JSON.stringify(db.exportCollections({ id: owner, role: "user" }))));
    if (!("collections" in bundle)) throw new Error("expected a bundle");
    expect(bundle.collections.map((c) => c.collection.name).sort()).toEqual(["Bikes", "Cars"]);

    const before = db.listCollections().length;
    const imported = db.importCollections(bundle.collections, importer);
    expect(imported).toHaveLength(2);
    expect(db.listCollections()).toHaveLength(before + 2);
    const cars = imported.map((i) => db.getCollection(i.collectionId)!).find((c) => c.name === "Cars")!;
    expect(cars).toMatchObject({ ownerId: importerId, itemCount: 1 });
    db.deleteCollection(hidden);
  });

  it("leaves nothing behind when a bundle import fails", () => {
    const before = db.listCollections().length;
    const broken = { ...exported, items: [{ ...exported.items[0], specs: { bad: 1n as unknown as number } }] };
    expect(() => db.importCollections([exported, broken], importer)).toThrow();
    expect(db.listCollections()).toHaveLength(before);
  });

  it("leaves nothing behind when the import fails", () => {
    const before = db.listCollections().length;
    // The last item can't be serialized — everything inserted before it must roll back.
    const broken = { ...exported, items: [...exported.items, { ...exported.items[0], url: "https://shop.example/c", specs: { bad: 1n as unknown as number } }] };
    expect(() => db.importCollection(broken, importer)).toThrow();
    expect(db.listCollections()).toHaveLength(before);
  });
  describe("hardening", () => {
    const admin = { id: addUser("admin@example.com", "admin"), role: "admin" as const };
    const item0 = exported.items[0];
    const file = (over: Partial<typeof exported> = {}) => collectionExportSchema.parse(JSON.parse(JSON.stringify({ ...exported, ...over })));

    it("only accepts http(s) links: item and start URLs must be, images and sources are dropped otherwise", () => {
      expect(collectionExportSchema.safeParse({ ...exported, items: [{ ...item0, url: "javascript:alert(1)" }] }).success).toBe(false);
      expect(collectionExportSchema.safeParse({ ...exported, collection: { ...exported.collection, startUrl: "file:///etc/passwd" } }).success).toBe(false);
      const parsed = file({ items: [{ ...item0, mainImage: "javascript:alert(1)", sources: { weight_kg: { origin: "web", sourceUrl: "data:text/html,x", confidence: 1 } } }] });
      expect(parsed.items[0].mainImage).toBeNull();
      expect(parsed.items[0].sources.weight_kg.sourceUrl).toBeNull();
    });

    it("drops a detection that doesn't fit and URL patterns that could backtrack", () => {
      const badShape = file({ collection: { ...exported.collection, detection: { listItemSelector: ".c", paginationType: "nope" } as never } });
      expect(badShape.collection.detection).toBeNull();

      const evil = file({ collection: { ...exported.collection, name: "Evil", detection: { listItemSelector: ".card", paginationType: "pages", itemUrlPattern: "^(a+)+$" } } });
      const { collectionId } = db.importCollection(evil, importer);
      expect(db.getCollection(collectionId)!.detection).toMatchObject({ listItemSelector: ".card", itemUrlPattern: null });

      const safe = file({ collection: { ...exported.collection, name: "Safe", detection: { listItemSelector: ".card", paginationType: "pages", itemUrlPattern: "^https://shop\\.example/p/" } } });
      expect(db.getCollection(db.importCollection(safe, importer).collectionId)!.detection?.itemUrlPattern).toBe("^https://shop\\.example/p/");
    });

    it("caps timestamps from the future", () => {
      const future = Date.now() + 365 * 86_400_000;
      const { collectionId } = db.importCollection(file({ collection: { ...exported.collection, name: "Future", createdAt: future }, items: [{ ...item0, indexedAt: future }] }), importer);
      expect(db.getCollection(collectionId)!.createdAt).toBeLessThanOrEqual(Date.now());
      expect(db.listItems(collectionId, 10)[0].indexedAt).toBeLessThanOrEqual(Date.now());
    });

    it("only an admin's import adds shared grouping and lookup cache rows", () => {
      const caches = {
        aliases: [{ identity: "trike z", canonical: "trike z 2025" }],
        webFacts: [{ identity: "trike z 2025", key: "weight_kg", value: 99, unit: "kg", sourceUrl: null, confidence: 1, found: true, fetchedAt: Date.now() }],
      };
      db.importCollection(file({ ...caches, collection: { ...exported.collection, name: "Trikes" } }), importer);
      expect(db.getCanonicalIdentity("trike z")).toBe("trike z");
      expect(db.getWebFact("trike z 2025", "weight_kg")).toBeNull();

      db.importCollection(file({ ...caches, collection: { ...exported.collection, name: "Trikes" } }), admin);
      expect(db.getCanonicalIdentity("trike z")).toBe("trike z 2025");
      expect(db.getWebFact("trike z 2025", "weight_kg")?.value).toBe(99);
    });

    it("never reuses imported rows for other collections until this server extracted or detected them", () => {
      const url = "https://solo.example/item";
      const imported = file({
        collection: { ...exported.collection, name: "Solo", host: "solo.example", detection: { listItemSelector: ".solo", paginationType: "pages" } },
        items: [{ ...item0, url, identity: "solo bike 2030", specs: { power_kw: 77 }, contentHash: "hx" }],
      });
      const { collectionId } = db.importCollection(imported, importer);
      expect(db.findReusableExtraction(url, "hx", -1)).toBeNull();
      expect(db.findPageValue(["solo bike 2030"], "power_kw")).toBeNull();
      expect(db.findDetectionForHost("solo.example", -1)).toBeNull();

      // A crawl of the imported collection re-extracts the item and re-detects the listing.
      db.upsertItem({ collectionId, url, title: "Solo", price: null, currency: null, mainImage: null, description: null, identity: "solo bike 2030", specs: { power_kw: 77 }, rawText: null, contentHash: "hx" });
      db.saveDetection(collectionId, { listItemSelector: ".solo", paginationType: "pages" });
      expect(db.findReusableExtraction(url, "hx", -1)?.specs).toContainEqual(expect.objectContaining({ key: "power_kw", value: 77 }));
      expect(db.findPageValue(["solo bike 2030"], "power_kw")).toEqual({ value: 77, url });
      expect(db.findDetectionForHost("solo.example", -1)).toMatchObject({ listItemSelector: ".solo" });
    });
  });
});
