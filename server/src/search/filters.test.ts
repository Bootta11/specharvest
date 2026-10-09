import { describe, expect, it } from "vitest";
import type { SpecKey } from "@specharvest/shared";
import { buildCandidateQuery, buildFacetQuery, mergeFilters } from "./filters.ts";

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

  it("matches any of several values with `in`", () => {
    const q = buildCandidateQuery(
      [
        { key: "fuel_type", op: "in", value: ["Diesel", "hybrid"] },
        { key: "mileage_km", op: "in", value: [1000, "2000", "lots"] },
      ],
      registry,
      null,
    );
    expect(q.sql).toContain("ulower(json_extract(specs, '$.' || json_quote(?))) IN (?,?)");
    expect(q.sql).toContain("CAST(json_extract(specs, '$.' || json_quote(?)) AS REAL) IN (?,?)");
    expect(q.params).toEqual(["fuel_type", "fuel_type", "diesel", "hybrid", "mileage_km", "mileage_km", 1000, 2000]);
    expect(q.active).toHaveLength(2);
  });

  it("skips `in` without usable values, and lists with any other op", () => {
    const q = buildCandidateQuery(
      [
        { key: "mileage_km", op: "in", value: ["lots"] },
        { key: "heated_seats", op: "in", value: ["yes"] },
        { key: "fuel_type", op: "gt", value: ["a", "b"] },
      ],
      registry,
      null,
    );
    expect(q.active).toHaveLength(0);
    expect(q.params).toEqual([]);
  });

  it("filters listing fields on their columns, where a missing value never matches", () => {
    const q = buildCandidateQuery(
      [
        { key: "product", op: "contains", value: "Golf" },
        { key: "collection", op: "in", value: [3, 5] },
        { key: "description", op: "exists" },
      ],
      registry,
      null,
    );
    expect(q.sql).toBe(
      "SELECT id FROM items WHERE gone_at IS NULL AND ulower(CAST(COALESCE(NULLIF(identity, ''), title) AS TEXT)) LIKE '%' || ? || '%' ESCAPE '\\' AND CAST(collection_id AS REAL) IN (?,?) AND (description IS NOT NULL AND description <> '')",
    );
    expect(q.params).toEqual(["golf", 3, 5]);
    expect(q.active).toHaveLength(3);
  });

  it("matches contains text literally", () => {
    expect(buildCandidateQuery([{ key: "title", op: "contains", value: "50%_OFF\\" }], registry, null).params).toEqual(["50\\%\\_off\\\\"]);
  });
});

describe("buildFacetQuery", () => {
  it("adds a 0/1 column per filter, with select-list params before the scope's", () => {
    const { sql, params } = buildFacetQuery(
      [
        { key: "mileage_km", op: "lt", value: 10000 },
        { key: "price", op: "exists" },
      ],
      registry,
      [3, 5],
    );
    expect(sql).toContain(", ((json_extract(specs, '$.' || json_quote(?)) IS NULL OR CAST(json_extract(specs, '$.' || json_quote(?)) AS REAL) < ?)) AS f0, ");
    expect(sql).toContain("1 AS f1");
    expect(sql).toMatch(/ FROM items WHERE collection_id IN \(\?,\?\) AND gone_at IS NULL$/);
    expect(params).toEqual(["mileage_km", "mileage_km", 10000, 3, 5]);
  });
});

describe("mergeFilters", () => {
  it("adds conditions on keys the plan doesn't filter yet", () => {
    const plan = { filters: [{ key: "price", op: "lte" as const, value: 15000 }], sort: null, semanticText: null, missingAttributes: [], show: [] };
    const merged = mergeFilters(plan, [
      { key: "price", op: "lte", value: 20000 },
      { key: "fuel_type", op: "eq", value: "diesel" },
    ]);
    expect(merged.filters).toEqual([
      { key: "price", op: "lte", value: 15000 },
      { key: "fuel_type", op: "eq", value: "diesel" },
    ]);
    expect(mergeFilters(plan, [])).toBe(plan);
  });
});
