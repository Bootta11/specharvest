import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "specharvest-regsyn-"));
process.env.DATA_DIR = dataDir;

const proposeKeyMerges = vi.fn(async () => [{ from: "boot_capacity_liters", to: "trunk_volume_l", factor: 1 }]);
vi.mock("../llm/consolidate.ts", () => ({ proposeKeyMerges }));

const db = await import("../db/sqlite.ts");
const { matchRegistrySynonyms } = await import("./registry-synonyms.ts");
const { sanitizePlan } = await import("../llm/parse-query.ts");

afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }));

describe("searched keys vs the collection's own fields", () => {
  const owner = Number(db.getDb().prepare("INSERT INTO users (email, password_hash, role, created_at) VALUES ('o@example.com', 'x', 'user', ?)").run(Date.now()).lastInsertRowid);
  const col = db.createCollection("Cars", "https://cars.example/list", "cars.example", owner);
  db.upsertSpecKey(col, { key: "trunk_volume_l", type: "number", unit: "l", label: "Prtljažnik", example: "380", origin: "page" });
  const boot = { key: "boot_capacity_liters", type: "number" as const, unit: "l", label: "boot space" };
  const plan = { filters: [], sort: { key: "boot_capacity_liters", dir: "desc" as const }, semanticText: null, missingAttributes: [boot], show: [] };

  it("maps a synonym to the existing field, once per collection registry", async () => {
    expect(await matchRegistrySynonyms([boot], db.listSpecKeys(col), col)).toBe(1);
    const fixed = sanitizePlan(plan, db.listSpecKeys(col), db.keyAliasesOf);
    expect(fixed.sort?.key).toBe("trunk_volume_l");
    expect(fixed.missingAttributes).toEqual([]);

    // Already compared with this registry: no second LLM call.
    await matchRegistrySynonyms([boot], db.listSpecKeys(col), col);
    expect(proposeKeyMerges).toHaveBeenCalledTimes(1);
  });

  it("compares again once the collection gains fields", async () => {
    const range = { key: "range_km", type: "number" as const, unit: "km", label: "range" };
    // Count this test's calls only (Vitest 5 clears mocks between tests anyway).
    proposeKeyMerges.mockClear();
    proposeKeyMerges.mockResolvedValueOnce([]);
    await matchRegistrySynonyms([range], db.listSpecKeys(col), col);
    db.upsertSpecKey(col, { key: "autonomy_km", type: "number", unit: "km", label: "Autonomija", example: "400", origin: "page" });
    proposeKeyMerges.mockResolvedValueOnce([]);
    await matchRegistrySynonyms([range], db.listSpecKeys(col), col);
    expect(proposeKeyMerges).toHaveBeenCalledTimes(2);
  });

  it("ignores merges with a unit conversion and keeps going when the LLM fails", async () => {
    const hp = { key: "engine_hp", type: "number" as const, unit: "hp", label: "power" };
    db.upsertSpecKey(col, { key: "power_kw", type: "number", unit: "kW", label: "Snaga", example: "85", origin: "page" });
    proposeKeyMerges.mockResolvedValueOnce([{ from: "engine_hp", to: "power_kw", factor: 0.7355 }]);
    expect(await matchRegistrySynonyms([hp], db.listSpecKeys(col), col)).toBe(0);
    expect(db.canonicalKey("engine_hp")).toBe("engine_hp");

    const torque = { key: "torque_nm", type: "number" as const, unit: "Nm", label: "torque" };
    proposeKeyMerges.mockRejectedValueOnce(new Error("down"));
    expect(await matchRegistrySynonyms([torque], db.listSpecKeys(col), col)).toBe(0);
    expect(db.registryChecked("torque_nm", db.registrySizes(col))).toBe(false);
  });
});
