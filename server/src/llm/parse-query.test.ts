import { describe, expect, it } from "vitest";
import type { SpecKey } from "@specharvest/shared";
import { sanitizePlan } from "./parse-query.ts";

const keys: SpecKey[] = [{ key: "power_kw", type: "number", unit: "kw", label: "Snaga", example: null, count: 3, origin: "page" }];

describe("sanitizePlan", () => {
  it("normalizes keys and lists unknown referenced keys as missing", () => {
    const plan = sanitizePlan(
      { filters: [{ key: "Power KW", op: "gt", value: 100 }, { key: "boot capacity liters", op: "gte", value: 400 }], sort: null, semanticText: "  ", missingAttributes: [] },
      keys,
    );
    expect(plan.filters.map((f) => f.key)).toEqual(["power_kw", "boot_capacity_liters"]);
    expect(plan.missingAttributes.map((m) => m.key)).toEqual(["boot_capacity_liters"]);
    expect(plan.semanticText).toBeNull();
  });

  it("drops missing attributes that the registry now has", () => {
    const plan = sanitizePlan({ filters: [], sort: { key: "power_kw", dir: "desc" }, semanticText: null, missingAttributes: [{ key: "power_kw", type: "number", unit: "kw", label: "power" }] }, keys);
    expect(plan.missingAttributes).toEqual([]);
  });

  it("keeps show keys, dedupes them against filters/sort and lists unknown ones as missing", () => {
    const plan = sanitizePlan(
      { filters: [{ key: "power_kw", op: "gt", value: 100 }], sort: null, semanticText: null, missingAttributes: [], show: ["Power KW", "boot capacity liters", "boot_capacity_liters"] },
      keys,
    );
    expect(plan.show).toEqual(["boot_capacity_liters"]);
    expect(plan.missingAttributes.map((m) => m.key)).toEqual(["boot_capacity_liters"]);
  });

  it("maps unknown keys to a registry synonym, else to the canonical name", () => {
    const synonyms = (k: string) => (k === "kw" ? ["power_kw", "kw"] : k === "trunk_volume_liters" ? ["boot_capacity_liters", "trunk_volume_liters"] : [k]);
    const plan = sanitizePlan(
      { filters: [{ key: "kw", op: "gt", value: 100 }], sort: { key: "trunk_volume_liters", dir: "desc" }, semanticText: null, missingAttributes: [{ key: "trunk_volume_liters", type: "number", unit: "l", label: "boot" }] },
      keys,
      synonyms,
    );
    expect(plan.filters[0].key).toBe("power_kw");
    expect(plan.sort?.key).toBe("boot_capacity_liters");
    expect(plan.missingAttributes.map((m) => m.key)).toEqual(["boot_capacity_liters"]);
  });

  it("defaults show to an empty list for older plans", () => {
    expect(sanitizePlan({ filters: [], sort: null, semanticText: null, missingAttributes: [] }, keys).show).toEqual([]);
  });
});
