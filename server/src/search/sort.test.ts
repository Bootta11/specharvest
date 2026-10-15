import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { QueryPlan, SearchRequest, SpecValue } from "@specharvest/shared";

// config.ts reads DATA_DIR at import time — point it at a throwaway dir first.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "specharvest-sort-"));
process.env.DATA_DIR = dataDir;

// A typed query's plan, without an LLM.
const typedPlan = vi.hoisted(() => ({ value: null as QueryPlan | null }));
vi.mock("../llm/parse-query.ts", async (orig) => ({
  ...(await orig<typeof import("../llm/parse-query.ts")>()),
  parseQuery: async () => typedPlan.value!,
}));
vi.mock("../db/lance.ts", () => ({ rankByVector: async () => new Map() }));
vi.mock("../embedding.ts", () => ({ embed: async () => [] }));

const db = await import("../db/sqlite.ts");
const { search } = await import("./hybrid.ts");

afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }));

const owner = Number(db.getDb().prepare("INSERT INTO users (email, password_hash, role, created_at) VALUES ('o@example.com', 'x', 'user', ?)").run(Date.now()).lastInsertRowid);
const viewer = { id: owner, role: "user" as const };
const cars = db.createCollection("Cars", "https://a.example/cars", "a.example", owner);
db.upsertSpecKey(cars, { key: "power_kw", type: "number", unit: "kW", label: "power", example: null, origin: "page" });

let n = 0;
/** Items get older the earlier they're added: indexed_at is set by hand so "newest first" is predictable. */
const add = (title: string, price: number | null, specs: Record<string, SpecValue>) => {
  const id = db.upsertItem({ collectionId: cars, url: `https://a.example/${++n}`, title, price, currency: price === null ? null : "EUR", mainImage: null, description: null, identity: null, specs, rawText: null });
  db.getDb().prepare("UPDATE items SET indexed_at = ? WHERE id = ?").run(1_000_000 + n, id);
  return id;
};
add("Cheap oldie", 3000, { power_kw: 55 });
add("Mid", 9000, { power_kw: 110 });
add("No price", null, { power_kw: 90 });
add("Pricey", 25000, { power_kw: 150 });
add("Newest", 12000, {});

const titles = async (req: Partial<SearchRequest>) => (await search({ collectionId: cars, enrich: false, ...req }, viewer, cars)).items.map((i) => i.title);

describe("search sort", () => {
  it("is newest first without a sort", async () => {
    expect(await titles({})).toEqual(["Newest", "Pricey", "No price", "Mid", "Cheap oldie"]);
  });

  it("sorts by price both ways, items without a price last", async () => {
    expect(await titles({ sort: { key: "price", dir: "asc" } })).toEqual(["Cheap oldie", "Mid", "Newest", "Pricey", "No price"]);
    expect(await titles({ sort: { key: "price", dir: "desc" } })).toEqual(["Pricey", "Newest", "Mid", "Cheap oldie", "No price"]);
  });

  it("sorts by a numeric spec and by name", async () => {
    expect(await titles({ sort: { key: "power_kw", dir: "desc" } })).toEqual(["Pricey", "Mid", "No price", "Cheap oldie", "Newest"]);
    expect(await titles({ sort: { key: "title", dir: "asc" } })).toEqual(["Cheap oldie", "Mid", "Newest", "No price", "Pricey"]);
  });

  it("sorts before the page is cut", async () => {
    expect(await titles({ sort: { key: "price", dir: "asc" }, limit: 1 })).toEqual(["Cheap oldie"]);
  });

  it("keeps the picked sort on a typed query without an order, and lets a typed order win", async () => {
    typedPlan.value = { filters: [], sort: null, semanticText: null, missingAttributes: [], show: [] };
    const kept = await search({ collectionId: cars, enrich: false, query: "cars", sort: { key: "price", dir: "desc" } }, viewer, cars);
    expect(kept.plan.sort).toEqual({ key: "price", dir: "desc" });
    expect(kept.items[0]!.title).toBe("Pricey");

    typedPlan.value = { ...typedPlan.value, sort: { key: "price", dir: "asc" } };
    const typed = await search({ collectionId: cars, enrich: false, query: "cheapest", sort: { key: "price", dir: "desc" } }, viewer, cars);
    expect(typed.plan.sort).toEqual({ key: "price", dir: "asc" });
    expect(typed.items[0]!.title).toBe("Cheap oldie");
  });

  it("orders by default when the sort key is unknown", async () => {
    expect(await titles({ sort: { key: "no_such_field", dir: "asc" } })).toEqual(["Newest", "Pricey", "No price", "Mid", "Cheap oldie"]);
  });
});
