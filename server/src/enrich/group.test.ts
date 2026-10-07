import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// config.ts reads DATA_DIR at import time — point it at a throwaway dir first.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "specharvest-group-"));
process.env.DATA_DIR = dataDir;
const db = await import("../db/sqlite.ts");
const { sameProduct, maybeSameProduct, regroup, matchSuggestions, resolvedIdentity, sameProductOf, productGroups, ungroupedCount } = await import("./group.ts");

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
    ["geely cityray 1.5 gk", "geely cityray gk 1.5 t-gdi 2026"],
    ["geely cityray 1.5 turbo gk 2026", "geely cityray gk 1.5 t-gdi 2026"],
    ["volkswagen golf life plus 2.0 tdi 2026", "volkswagen golf life plus 2.0 tdi scr 2026"],
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
    ["volkswagen golf 2.0 tdi 2026", "volkswagen golf 1.5 tsi 2026"],
    ["toyota corolla 1.8 hybrid 2025", "toyota corolla 1.8 2025 phev"],
    ["geely cityray 1.5 tgdi 2026", "geely cityray gk 1.5 t-gdi 2026"],
    ["geely starray em-i 2026", "geely starray em-i 1.5 t-gdi phev max 2026"],
    ["chery tiggo 8 pro 1.6 noble 7dct 2026", "chery tiggo 8 pro 1.6 noble cvt 2026"],
  ])("rejects %s ~ %s", (a, b) => expect(sameProduct(a, b)).toBe(false));
});

describe("maybeSameProduct", () => {
  it.each([
    ["geely starray em-i 2026", "geely starray em-i 1.5 t-gdi phev max 2026"],
    ["geely cityray 1.5 tgdi 2026", "geely cityray gk 1.5 t-gdi 2026"],
    ["geely cityray 1.5 tgdi 2026", "geely cityray gf 1.5 2026"],
  ])("suggests %s ~ %s", (a, b) => expect(maybeSameProduct(a, b)).toBe(true));

  it.each([
    ["geely starray 1.5 2025", "geely starray 2026"], // different model year
    ["geely starray 2026", "geely cityray 2026"],
    ["geely cityray gk 1.5 2026", "geely cityray gf 1.5 2026"], // different trims
    ["geely cityray 1.5 gk", "geely cityray gk 1.5 2026"], // certain, not "maybe"
  ])("does not suggest %s ~ %s", (a, b) => expect(maybeSameProduct(a, b)).toBe(false));
});

describe("regroup, suggestions & decisions", () => {
  const c = db.createCollection("geely", "https://g.example/", "g.example");
  const base = { collectionId: c, price: null, currency: null, mainImage: null, description: null, rawText: null, specs: {} };
  const names = [
    "geely cityray 1.5 gk",
    "geely cityray 1.5 tgdi 2026",
    "geely cityray 1.5 turbo gk 2026",
    "geely cityray gk 1.5 t-gdi 2026",
    "geely cityray gf 1.5 2026",
    "geely starray 1.5 2025",
    "geely starray 2026",
    "geely starray em-i 1.5 t-gdi phev max 2026",
    "geely starray em-i 2026",
  ];
  names.forEach((identity, n) => db.upsertItem({ ...base, url: `https://g.example/${n}`, title: identity, identity }));
  db.saveIdentityAliases(names.map((identity) => ({ identity, canonical: identity })));
  const items = () => db.listItems(c, 100);

  it("merges the certain matches without the LLM", () => {
    regroup(names);
    const groups = productGroups(items());
    const gk = groups.find((g) => g.listings.length === 3)!;
    expect(gk.listings.map((l) => l.identity).sort()).toEqual(["geely cityray 1.5 gk", "geely cityray 1.5 turbo gk 2026", "geely cityray gk 1.5 t-gdi 2026"]);
    expect(groups).toHaveLength(7);
  });

  it("suggests the uncertain ones, with every candidate", () => {
    regroup(names);
    const gk = resolvedIdentity({ identity: "geely cityray 1.5 gk", title: "" });
    const s = matchSuggestions(items());
    expect(s.map((x) => [x.identity, x.candidates.map((k) => k.canonical).sort()])).toEqual([
      ["geely cityray 1.5 tgdi 2026", ["geely cityray gf 1.5 2026", gk].sort()],
      ["geely starray 2026", ["geely starray em-i 1.5 t-gdi phev max 2026", "geely starray em-i 2026"]],
      ["geely starray em-i 2026", ["geely starray em-i 1.5 t-gdi phev max 2026"]],
    ]);
    // Candidates with more listings first.
    expect(s[0].candidates[0]).toMatchObject({ canonical: gk, listings: 3 });
  });

  it("accepting merges, rejecting hides the suggestion for good", () => {
    regroup(names);
    db.mergeCanonical("geely starray em-i 2026", "geely starray em-i 1.5 t-gdi phev max 2026");
    for (const k of matchSuggestions(items())[0].candidates) db.rejectPair("geely cityray 1.5 tgdi 2026", k.canonical);
    db.rejectPair("geely starray 2026", "geely starray em-i 1.5 t-gdi phev max 2026");
    expect(matchSuggestions(items())).toEqual([]);
    expect(resolvedIdentity({ identity: "geely starray em-i 2026", title: "" })).toBe("geely starray em-i 1.5 t-gdi phev max 2026");
  });

  it("a split name stays out of its old group, even after regrouping", () => {
    const canonical = resolvedIdentity({ identity: "geely cityray 1.5 gk", title: "" });
    const member = names.slice(0, 4).find((n) => n !== canonical && resolvedIdentity({ identity: n, title: "" }) === canonical)!;
    db.rejectPair(member, canonical);
    db.splitIdentity(member);
    regroup(names);
    expect(resolvedIdentity({ identity: member, title: "" })).toBe(member);
  });
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

describe("sameProductOf", () => {
  it("lists the other listings of the grouped product, limited to the viewer's collections", () => {
    const mine = db.createCollection("mine", "https://a.example/", "a.example");
    const theirs = db.createCollection("theirs", "https://b.example/", "b.example");
    const base = { price: null, currency: null, mainImage: null, description: null, rawText: null, specs: {} };
    db.saveIdentityAliases([
      { identity: "kia ceed 1.5 2025", canonical: "kia ceed 1.5 2025" },
      { identity: "kia cee'd 1.5 2025", canonical: "kia ceed 1.5 2025" },
    ]);
    const self = db.upsertItem({ ...base, collectionId: mine, url: "https://a.example/1", title: "Ceed", identity: "kia ceed 1.5 2025" });
    db.upsertItem({ ...base, collectionId: mine, url: "https://a.example/2", title: "Cee'd", identity: "kia cee'd 1.5 2025" });
    db.upsertItem({ ...base, collectionId: theirs, url: "https://b.example/1", title: "Ceed (other user)", identity: "kia ceed 1.5 2025" });
    db.upsertItem({ ...base, collectionId: mine, url: "https://a.example/3", title: "Rio", identity: "kia rio 1.2 2025" });

    const same = sameProductOf({ id: self, identity: "kia ceed 1.5 2025", title: "Ceed" }, [mine])!;
    expect(same.canonical).toBe("kia ceed 1.5 2025");
    expect(same.listings.map((l) => l.title)).toEqual(["Cee'd"]);
    expect(same.more).toBe(0);
    expect(sameProductOf({ id: self, identity: "kia ceed 1.5 2025", title: "Ceed" }, null)!.listings).toHaveLength(2);
    expect(sameProductOf({ id: 0, identity: "kia rio 1.2 2025", title: "Rio" }, [mine])!.listings.map((l) => l.title)).toEqual(["Rio"]);
    expect(sameProductOf({ id: 999, identity: "nothing like it", title: "x" }, [mine])).toBeNull();
  });
});

describe("collection products", () => {
  it("groups a collection's listings by product and counts variants once", () => {
    const c = db.createCollection("cars", "https://c.example/", "c.example");
    const base = { collectionId: c, price: null, currency: null, mainImage: null, description: null, rawText: null, specs: {} };
    db.saveIdentityAliases([
      { identity: "opel astra 1.2 2025", canonical: "opel astra 1.2 2025" },
      { identity: "opel astra 1.2t 2025 edition", canonical: "opel astra 1.2t 2025 edition" },
      { identity: "opel astra 1,2 2025", canonical: "opel astra 1.2 2025" },
    ]);
    db.upsertItem({ ...base, url: "https://c.example/1", title: "Astra", identity: "opel astra 1.2 2025" });
    db.upsertItem({ ...base, url: "https://c.example/2", title: "Astra 1,2", identity: "opel astra 1,2 2025" });
    db.upsertItem({ ...base, url: "https://c.example/3", title: "Astra 1.2", identity: "opel astra 1.2 2025" });
    db.upsertItem({ ...base, url: "https://c.example/4", title: "Astra Edition", identity: "opel astra 1.2t 2025 edition" });
    db.upsertItem({ ...base, url: "https://c.example/5", title: "Corsa  Basic", identity: null });

    const items = db.listItems(c, 100);
    const groups = productGroups(items);
    expect(groups.map((g) => [g.canonical, g.listings.length])).toEqual([
      ["opel astra 1.2 2025", 3],
      ["corsa basic", 1],
      ["opel astra 1.2t 2025 edition", 1],
    ]);
    expect(db.listCollections().find((x) => x.id === c)?.productCount).toBe(3);
    expect(ungroupedCount(items)).toBe(1); // "corsa basic" never went through grouping
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
