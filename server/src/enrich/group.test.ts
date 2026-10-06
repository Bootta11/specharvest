import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// config.ts reads DATA_DIR at import time — point it at a throwaway dir first.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "specharvest-group-"));
process.env.DATA_DIR = dataDir;
const db = await import("../db/sqlite.ts");
const { sameProduct, resolvedIdentity } = await import("./group.ts");

afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }));

describe("sameProduct", () => {
  it.each([
    ["volkswagen golf life plus 2.0 tdi 2026", "volkswagen golf life+ 2.0 tdi 85kw 2026"],
    ["volkswagen golf life plus 2.0 tdi 2026", "volkswagen golf life plus 2.0 tdi 85 kw 2026"],
    ["suzuki sx4 s-cross 1.4 gl+ 4wd at 2025", "suzuki sx4 scross 1.4 gl plus 4wd at 2025"],
    ["škoda kamiq fl selection 1.5 tsi dsg7 2026", "skoda kamiq selection 1.5 tsi dsg7 2026"],
    ["baic x55 1.5 2025", "baic x55 1.5"],
    ["kia sportage fresh 1.6 2026", "kia sportage fresh 1.6 t-gdi 150hp fwd 2026"],
    ["changan uni-t tech a/t 2026", "changan uni-t tech at 1.5 2026"],
    ["peugeot 3008 allure pack hybrid 2026", "peugeot 3008 allure pack hybrid 145 2026"],
    ["volkswagen golf life plus 2.0 tdi 85kw 2026", "volkswagen golf life+ 2.0 tdi 115hp 2026"],
  ])("accepts %s ~ %s", (a, b) => expect(sameProduct(a, b)).toBe(true));

  it.each([
    ["baic x7 1.5 2025", "baic x7 1.5 2026"],
    ["baic x7 1.5 2025", "baic x7 1.5t dct 2025"],
    ["volkswagen golf life 2.0 tdi 85kw 2026", "volkswagen golf life 2.0 tdi 110kw 2026"],
    ["volkswagen golf life 2.0 tdi 2026", "volkswagen golf style 2.0 tdi 2026"],
    ["suzuki vitara 1.4 4wd 2025", "suzuki vitara 1.4 2wd 2025"],
    ["kia sportage fresh 1.6 2026", "hyundai sportage fresh 1.6 2026"],
    ["volvo xc40 2.0 b3 core 2025", "volvo xc40 2.0 b3 core plus pro 2025"],
    ["opel mokka edition hybrid 2026", "opel mokka gs hybrid 2026"],
    ["suzuki sx4 s-cross 1.4 hybrid gl+ 2026", "suzuki sx4 s-cross 1.4 hybrid gl+ premium 2026"],
    ["jeep compass altitude 1.2 e-hybrid dct6 2026", "jeep compass 1.2 e-hybrid dct6 2026"],
    ["volkswagen golf life 2.0 tdi 85kw 2026", "volkswagen golf life 2.0 tdi 150hp 2026"],
    ["chery tiggo 8 pro 1.6 noble 7dct 2026", "chery tiggo 8 pro 1.6 noble cvt 2026"],
  ])("rejects %s ~ %s", (a, b) => expect(sameProduct(a, b)).toBe(false));
});

describe("identity aliases & sibling values", () => {
  const c = db.createCollection("shop", "https://shop.example/a", "shop.example");
  const base = { collectionId: c, price: null, currency: null, mainImage: null, description: null, rawText: null };

  it("resolves an item to the canonical identity it was grouped under", () => {
    db.saveIdentityAliases([
      { identity: "vw golf life+ 2.0 tdi 2026", canonical: "vw golf life plus 2.0 tdi 2026" },
      { identity: "vw golf life plus 2.0 tdi 2026", canonical: "vw golf life plus 2.0 tdi 2026" },
    ]);
    expect(resolvedIdentity({ identity: "vw golf life+ 2.0 tdi 2026", title: "x" })).toBe("vw golf life plus 2.0 tdi 2026");
    expect(resolvedIdentity({ identity: null, title: "Unknown  Thing" })).toBe("unknown thing");
    expect(db.aliasesOf("vw golf life plus 2.0 tdi 2026").sort()).toEqual(["vw golf life plus 2.0 tdi 2026", "vw golf life+ 2.0 tdi 2026"]);
    expect(db.knownCanonicals("vw")).toEqual(["vw golf life plus 2.0 tdi 2026"]);
  });

  it("finds a value a sibling listing states on its own page, but not a web-filled one", () => {
    db.upsertItem({ ...base, url: "https://shop.example/1", title: "Golf", identity: "vw golf life+ 2.0 tdi 2026", specs: { boot_l: 381, awd: false } });
    const webOnly = db.upsertItem({ ...base, url: "https://shop.example/2", title: "Golf", identity: "vw golf life plus 2.0 tdi 2026", specs: {} });
    db.setItemSpec(webOnly, "seats", 5, { origin: "web", sourceUrl: null, confidence: 0.9 });

    const ids = db.aliasesOf("vw golf life plus 2.0 tdi 2026");
    expect(db.findPageValue(ids, "boot_l")).toEqual({ value: 381, url: "https://shop.example/1" });
    expect(db.findPageValue(ids, "awd")).toEqual({ value: false, url: "https://shop.example/1" });
    expect(db.findPageValue(ids, "seats")).toBeNull();
    expect(db.findPageValue(["other product"], "boot_l")).toBeNull();

    db.upsertItem({ ...base, url: "https://shop.example/3", title: "Golf", identity: "vw golf life plus 2.0 tdi 2026", specs: { wheelbase_mm: 0, color: "" } });
    expect(db.findPageValue(ids, "wheelbase_mm")).toBeNull();
    expect(db.findPageValue(ids, "color")).toBeNull();
  });
});

describe("not-found TTL", () => {
  it("expires old 'not found' facts but keeps found ones", () => {
    db.saveWebFact({ identity: "p", key: "a", value: null, unit: null, sourceUrl: null, confidence: null, found: false });
    db.saveWebFact({ identity: "p", key: "b", value: 1, unit: null, sourceUrl: null, confidence: 0.9, found: true });
    expect(db.getWebFact("p", "a")?.found).toBe(false);
    const old = Date.now() - 31 * 86_400_000;
    db.getDb().prepare("UPDATE web_facts SET fetched_at = ? WHERE identity = 'p'").run(old);
    expect(db.getWebFact("p", "a")).toBeNull();
    expect(db.getWebFact("p", "b")?.value).toBe(1);
  });
});
