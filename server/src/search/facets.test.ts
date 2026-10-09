import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { Facet, Filter, SpecKey, SpecValue } from "@specharvest/shared";
import type { CollectionScope } from "../db/sqlite.ts";

// config.ts reads DATA_DIR at import time — point it at a throwaway dir first.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "specharvest-facets-"));
process.env.DATA_DIR = dataDir;
const db = await import("../db/sqlite.ts");
const { computeFacets, FACET_VALUE_CAP } = await import("./facets.ts");
const { buildCandidateQuery } = await import("./filters.ts");

afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }));

let n = 0;
type Extra = { title?: string; price?: number | null; currency?: string | null; description?: string | null; identity?: string | null };
const addItem = (collectionId: number, specs: Record<string, SpecValue>, extra: Extra = {}) => {
  const url = `https://shop.example/${++n}`;
  const id = db.upsertItem({
    collectionId,
    url,
    title: extra.title ?? `Car ${n}`,
    price: extra.price ?? null,
    currency: extra.currency ?? null,
    mainImage: null,
    description: extra.description ?? null,
    identity: extra.identity ?? null,
    specs,
    rawText: null,
  });
  return { id, url };
};
const spec = (collectionId: number, key: string, type: SpecKey["type"], unit: string | null = null) =>
  db.upsertSpecKey(collectionId, { key, type, unit, label: key, example: null, origin: "page" });

const cars = db.createCollection("Cars", "https://a.example/cars", "a.example");
const vans = db.createCollection("Vans", "https://b.example/vans", "b.example");
for (const c of [cars, vans]) {
  spec(c, "fuel_type", "string");
  spec(c, "mileage_km", "number", "km");
  spec(c, "parking_camera", "boolean");
}
const skoda = addItem(cars, { fuel_type: "diesel", mileage_km: 50000, parking_camera: true }, { title: "Škoda Octavia", price: 10000, currency: "BAM", description: "garage kept", identity: "skoda octavia 2019" });
const dieselNoCamera = addItem(cars, { fuel_type: "Diesel", mileage_km: 120000, parking_camera: false }, { price: 8000, currency: "BAM" });
const petrol = addItem(cars, { fuel_type: "petrol", mileage_km: 30000, parking_camera: true }, { price: 15000, currency: "EUR" });
addItem(cars, { fuel_type: "hybrid", mileage_km: 20000 });
const sale = addItem(cars, { mileage_km: 90000 }, { title: "Golf 50% off" }); // no product name
const van = addItem(vans, { fuel_type: "diesel", mileage_km: 200000 }, { price: 20000, currency: "BAM" });
const goneVan = addItem(vans, { fuel_type: "petrol", mileage_km: 1000 });
db.markGone(vans, [van.url]);

const facetsOf = (filters: Filter[], scope: CollectionScope = cars, includeGone = false) => {
  const keys = db.listSpecKeys(scope);
  const q = buildCandidateQuery(filters, keys, scope, includeGone);
  const list = computeFacets(q.active, keys, scope, includeGone);
  return (key: string) => list.find((f) => f.key === key) as Facet;
};
const ids = (filters: Filter[], scope: CollectionScope = cars) => {
  const q = buildCandidateQuery(filters, db.listSpecKeys(scope), scope);
  return db.queryItemIds(q.sql, q.params).sort();
};

describe("computeFacets", () => {
  it("counts every field of the scope, text values case-insensitively", () => {
    const facet = facetsOf([]);
    expect(facet("fuel_type")).toMatchObject({
      key: "fuel_type",
      kind: "values",
      count: 4,
      values: [
        { value: "diesel", count: 2 },
        { value: "hybrid", count: 1 },
        { value: "petrol", count: 1 },
      ],
      more: 0,
    });
    expect(facet("mileage_km")).toMatchObject({ key: "mileage_km", kind: "range", count: 5, min: 20000, max: 120000, unit: "km" });
    expect(facet("parking_camera")).toMatchObject({ key: "parking_camera", kind: "boolean", count: 3, yes: 2, no: 1 });
  });

  it("covers the listing fields", () => {
    const facet = facetsOf([]);
    // BAM and EUR prices: no single currency to show.
    expect(facet("price")).toMatchObject({ key: "price", kind: "range", count: 3, min: 8000, max: 15000, unit: null });
    expect(facet("title")).toMatchObject({ key: "title", kind: "text", count: 5 });
    expect(facet("description")).toMatchObject({ key: "description", kind: "text", count: 1 });
    expect(facet("product")).toMatchObject({ key: "product", kind: "text", count: 5 });
    expect(facet("currency")).toMatchObject({ kind: "values", values: [{ value: "BAM", count: 2 }, { value: "EUR", count: 1 }] });
    expect(facet("collection")).toMatchObject({ kind: "values", values: [{ value: cars, count: 5 }] });
  });

  it("counts listings without a value per field", () => {
    const facet = facetsOf([]);
    expect(facet("description").missing).toBe(4);
    expect(facet("currency").missing).toBe(2);
    expect(facet("price").missing).toBe(2);
    expect(facet("fuel_type").missing).toBe(1);
    expect(facet("collection").missing).toBe(0);
    // Product names fall back to the title, so none is missing.
    expect(facet("product")).toMatchObject({ count: 5, missing: 0 });
    // Filtered on a strict field: its own missing listings are the ones left out; other fields count matches only.
    const byCurrency = facetsOf([{ key: "currency", op: "eq", value: "BAM" }]);
    expect(byCurrency("currency").missing).toBe(2);
    expect(byCurrency("description")).toMatchObject({ count: 1, missing: 1 });
  });

  it("counts a filtered field over the other filters only, so its other options stay visible", () => {
    const facet = facetsOf([{ key: "fuel_type", op: "in", value: ["diesel"] }]);
    expect(facet("fuel_type")).toMatchObject({ count: 4, values: [{ value: "diesel", count: 2 }, { value: "hybrid", count: 1 }, { value: "petrol", count: 1 }] });
    expect(facet("mileage_km")).toMatchObject({ count: 2, min: 50000, max: 120000 });
    expect(facet("parking_camera")).toMatchObject({ yes: 1, no: 1 });
  });

  it("counts a row failing two fields nowhere, and a row failing one only toward that field", () => {
    const facet = facetsOf([
      { key: "fuel_type", op: "eq", value: "petrol" },
      { key: "parking_camera", op: "eq", value: false },
    ]);
    // Only the diesel without a camera fails just the fuel filter; only the petrol with one fails just the camera filter.
    expect(facet("fuel_type")).toMatchObject({ count: 1, values: [{ value: "Diesel", count: 1 }, { value: "petrol", count: 0 }] });
    expect(facet("parking_camera")).toMatchObject({ count: 1, yes: 1, no: 0 });
    expect(facet("mileage_km")).toMatchObject({ count: 0, min: null, max: null });
  });

  it("doesn't count an item missing a filtered spec toward other fields", () => {
    const facet = facetsOf([{ key: "parking_camera", op: "eq", value: true }]);
    // The hybrid has no camera value: it can't be judged, so it isn't among the fuel options.
    expect(facet("fuel_type")).toMatchObject({ values: [{ value: "diesel", count: 1 }, { value: "petrol", count: 1 }] });
  });

  it("leaves sold/removed listings out unless asked for", () => {
    expect(facetsOf([], vans)("fuel_type")).toMatchObject({ count: 1, values: [{ value: "diesel", count: 1 }] });
    expect(facetsOf([], vans)("price")).toMatchObject({ min: 20000, max: 20000, unit: "BAM" });
    expect(facetsOf([], vans, true)("fuel_type")).toMatchObject({ count: 2 });
  });

  it("lists every collection of a multi-collection scope, also while one is picked", () => {
    const facet = facetsOf([{ key: "collection", op: "in", value: [vans] }], [cars, vans]);
    expect(facet("collection")).toMatchObject({ values: [{ value: cars, count: 5 }, { value: vans, count: 1 }] });
    expect(facet("mileage_km")).toMatchObject({ count: 1, min: 200000, max: 200000 });
  });

  it("keeps a ticked value listed past the cap", () => {
    const many = db.createCollection("Colors", "https://c.example/colors", "c.example");
    spec(many, "color", "string");
    for (let i = 0; i < FACET_VALUE_CAP + 2; i++) addItem(many, { color: `c${String(i).padStart(3, "0")}` });
    expect(facetsOf([], many)("color")).toMatchObject({ more: 2 });
    const facet = facetsOf([{ key: "color", op: "eq", value: "C501" }], many)("color");
    expect(facet).toMatchObject({ more: 1 });
    expect(facet.kind === "values" && facet.values.at(-1)).toEqual({ value: "c501", count: 1 });
  });
});

describe("candidate query on SQLite", () => {
  it("compares text Unicode-aware and contains literally", () => {
    expect(ids([{ key: "title", op: "contains", value: "ŠKODA" }])).toEqual([skoda.id]);
    expect(ids([{ key: "title", op: "contains", value: "50%" }])).toEqual([sale.id]);
    expect(ids([{ key: "title", op: "contains", value: "%" }])).toEqual([sale.id]);
    expect(ids([{ key: "title", op: "contains", value: "_" }])).toEqual([]);
  });

  it("drops listings missing a strict field instead of keeping them as unknown", () => {
    expect(ids([{ key: "description", op: "contains", value: "garage" }])).toEqual([skoda.id]);
    // No product name: matched by the title instead.
    expect(ids([{ key: "product", op: "contains", value: "golf" }])).toEqual([sale.id]);
    expect(ids([{ key: "currency", op: "neq", value: "eur" }])).toEqual([skoda.id, dieselNoCamera.id].sort());
    expect(ids([{ key: "currency", op: "in", value: ["bam", "EUR"] }])).toEqual([skoda.id, dieselNoCamera.id, petrol.id].sort());
    expect(ids([{ key: "collection", op: "eq", value: vans }], [cars, vans])).toEqual([van.id]);
    expect(ids([{ key: "fuel_type", op: "in", value: ["DIESEL", "petrol"] }], vans)).toEqual([van.id]);
    expect(goneVan.id).toBeGreaterThan(0);
  });
});
