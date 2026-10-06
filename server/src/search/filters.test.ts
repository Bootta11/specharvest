import { describe, expect, it } from "vitest";
import type { SpecKey } from "@specharvest/shared";
import { buildCandidateQuery } from "./filters.ts";

const key = (k: string, type: SpecKey["type"]): SpecKey => ({ key: k, type, unit: null, label: k, example: null, count: 1, origin: "page" });
const registry = [key("mileage_km", "number"), key("heated_seats", "boolean"), key("fuel_type", "string")];

describe("buildCandidateQuery", () => {
  it("binds keys and values as parameters, tolerating missing values", () => {
    const q = buildCandidateQuery(
      [
        { key: "mileage_km", op: "lt", value: 10000 },
        { key: "heated_seats", op: "eq", value: true },
        { key: "fuel_type", op: "eq", value: "Diesel" },
      ],
      registry,
      7,
    );
    expect(q.sql).toContain("collection_id = ?");
    expect(q.sql).toContain("IS NULL OR");
    expect(q.sql).not.toContain("mileage_km");
    expect(q.params).toEqual([7, "mileage_km", "mileage_km", 10000, "heated_seats", "heated_seats", 1, "fuel_type", "fuel_type", "diesel"]);
    expect(q.active).toHaveLength(3);
    expect(q.pending).toHaveLength(0);
  });

  it("routes unknown keys to pending instead of SQL", () => {
    const q = buildCandidateQuery([{ key: "boot_capacity_liters", op: "gte", value: 500 }], registry, null);
    expect(q.pending.map((f) => f.key)).toEqual(["boot_capacity_liters"]);
    expect(q.sql).toBe("SELECT id FROM items WHERE gone_at IS NULL");
    expect(q.params).toEqual([]);
  });

  it("hides gone listings unless asked for", () => {
    expect(buildCandidateQuery([], registry, 3).sql).toBe("SELECT id FROM items WHERE collection_id = ? AND gone_at IS NULL");
    expect(buildCandidateQuery([], registry, 3, true).sql).toBe("SELECT id FROM items WHERE collection_id = ?");
    expect(buildCandidateQuery([], registry, null, true).sql).toBe("SELECT id FROM items");
  });

  it("uses the price column directly", () => {
    const q = buildCandidateQuery([{ key: "price", op: "lte", value: 50000 }], registry, null);
    expect(q.sql).toContain("CAST(price AS REAL) <= ?");
    expect(q.params).toEqual([50000]);
  });

  it("skips filters whose value can't be coerced", () => {
    const q = buildCandidateQuery([{ key: "mileage_km", op: "gt", value: "lots" }], registry, null);
    expect(q.active).toHaveLength(0);
    expect(q.params).toEqual([]);
  });

  it("keeps hostile key names out of the SQL text", () => {
    const evil = "x') OR 1=1 --";
    const q = buildCandidateQuery([{ key: evil, op: "eq", value: "a" }], [key(evil, "string")], null);
    expect(q.sql).not.toContain("OR 1=1");
    expect(q.params).toContain(evil);
  });
});
