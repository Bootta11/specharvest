import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// config.ts reads DATA_DIR at import time — point it at a throwaway dir first.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "specharvest-groups-"));
process.env.DATA_DIR = dataDir;
const db = await import("./sqlite.ts");

afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }));

const addUser = (email: string) =>
  Number(db.getDb().prepare("INSERT INTO users (email, password_hash, role, created_at) VALUES (?, 'x', 'user', ?)").run(email, Date.now()).lastInsertRowid);

const addItem = (collectionId: number, url: string, specs: Record<string, number> = {}) =>
  db.upsertItem({ collectionId, url, title: url, price: null, currency: null, mainImage: null, description: null, identity: null, specs, rawText: null });

describe("collection groups", () => {
  const me = addUser("me@example.com");
  const other = addUser("other@example.com");
  const viewer = { id: me, role: "user" as const };

  const carsA = db.createCollection("Cars A", "https://a.example/cars", "a.example", me);
  const carsB = db.createCollection("Cars B", "https://b.example/cars", "b.example", me);
  const bikes = db.createCollection("Bikes", "https://a.example/bikes", "a.example", me);
  const sharedCars = db.createCollection("Their cars", "https://c.example/cars", "c.example", other);
  db.setCollectionShared(sharedCars, true);
  addItem(carsA, "https://a.example/1", { power_kw: 100 });
  addItem(carsB, "https://b.example/1", { power_kw: 120 });
  addItem(carsB, "https://b.example/2");
  addItem(bikes, "https://a.example/bike", { weight_kg: 12 });
  addItem(sharedCars, "https://c.example/1");
  db.upsertSpecKey(carsA, { key: "power_kw", type: "number", unit: "kW", label: "Power", example: "100", origin: "page" });
  db.upsertSpecKey(bikes, { key: "weight_kg", type: "number", unit: "kg", label: "Weight", example: "12", origin: "page" });

  const groupId = db.createGroup(me, "Cars", [carsA, carsB, sharedCars]);

  it("lists the user's groups with readable members and item counts", () => {
    expect(db.listGroups(viewer)).toEqual([expect.objectContaining({ id: groupId, name: "Cars", collectionIds: [carsA, carsB, sharedCars], itemCount: 4 })]);
    expect(db.listGroups({ id: other, role: "user" })).toEqual([]);
  });

  it("scopes items and keys to the member collections", () => {
    const scope = db.groupScope(groupId, viewer);
    expect(db.listItems(scope, 50).map((i) => i.collectionId).sort()).toEqual([carsA, carsB, carsB, sharedCars].sort());
    expect(db.listSpecKeys(scope).map((k) => k.key)).toEqual(["power_kw"]);
  });

  it("keeps a group's recent searches apart from all collections", () => {
    db.recordSearch(me, db.historySlot(null, groupId), "diesel");
    db.recordSearch(me, db.historySlot(null), "bike");
    expect(db.listRecentQueries(me, db.historySlot(null, groupId)).map((r) => r.query)).toEqual(["diesel"]);
    expect(db.listRecentQueries(me, db.historySlot(null)).map((r) => r.query)).toEqual(["bike"]);
  });

  it("renames and replaces members", () => {
    db.updateGroup(groupId, { name: "Cars only mine", collectionIds: [carsA, carsB] });
    expect(db.getGroup(groupId, viewer)).toMatchObject({ name: "Cars only mine", collectionIds: [carsA, carsB], ownerId: me });
    db.updateGroup(groupId, { collectionIds: [carsA, carsB, sharedCars] });
  });

  it("drops members that are unshared or deleted", () => {
    db.setCollectionShared(sharedCars, false);
    expect(db.groupScope(groupId, viewer)).toEqual([carsA, carsB]);
    db.deleteCollection(carsB);
    expect(db.groupScope(groupId, viewer)).toEqual([carsA]);
  });

  it("deletes the group with its members and recent searches", () => {
    db.deleteGroup(groupId);
    expect(db.getGroup(groupId, viewer)).toBeNull();
    expect(db.getDb().prepare("SELECT COUNT(*) AS n FROM collection_group_members WHERE group_id = ?").get(groupId)).toEqual({ n: 0 });
    expect(db.listRecentQueries(me, db.historySlot(null, groupId))).toEqual([]);
  });
});
