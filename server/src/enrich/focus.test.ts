import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// config.ts reads DATA_DIR at import time — point it at a throwaway dir first.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "specharvest-focus-"));
process.env.DATA_DIR = dataDir;

/** Every LLM call, by purpose. Pages saying "prvi vlasnik" (first owner) match; "drugi vlasnik" don't; others don't say. */
const calls: Array<{ purpose: string; user: string }> = [];
vi.mock("../llm/client.ts", () => ({
  llmBlocked: () => false,
  askForJson: vi.fn(async (_schema: { parse: (v: unknown) => unknown }, _system: string, user: string, opts: { purpose: string }) => {
    calls.push({ purpose: opts.purpose, user });
    const page = user.slice(user.indexOf("Page text:"));
    const focus = page.includes("prvi vlasnik")
      ? { match: true, evidence: "Prvi vlasnik, servisna knjiga" }
      : page.includes("drugi vlasnik")
        ? { match: false, evidence: "drugi vlasnik" }
        : { match: null, evidence: "nothing" };
    const specs = page.includes("vlasnik") ? [["first_owner", focus.match, null, "Vlasnik"], ["matches_focus", true]] : [];
    const data = opts.purpose === "extract" ? { title: "Golf 7", price: 9000, specs: [["mileage_km", 120000, "km"], ...specs], focus } : { specs, focus };
    return { data: _schema.parse(data), citations: [], webSearches: 0 };
  }),
}));
vi.mock("../db/lance.ts", () => ({ upsertVector: vi.fn(async () => {}) }));
vi.mock("../embedding.ts", () => ({ embed: vi.fn(async () => [0]) }));

const db = await import("../db/sqlite.ts");
const { extractItem } = await import("../llm/extract.ts");
const { startFocusCheck } = await import("./focus.ts");

afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }));
beforeEach(() => {
  calls.length = 0;
});

const snapshot = (text: string) => ({ url: "https://cars.example/ad/1", text, stableText: text, prefill: { title: null, price: null, currency: null, image: null, description: null }, images: [] });

async function finished(jobId: number) {
  for (let i = 0; i < 200; i++) {
    const job = db.getJob(jobId)!;
    if (job.status === "done" || job.status === "failed" || job.status === "stopped") return job;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`job ${jobId} did not finish`);
}

describe("extraction with a crawl focus", () => {
  it("asks for the focus and returns its answer with the quote", async () => {
    const x = await extractItem(snapshot("VW Golf 7, prvi vlasnik, servisna knjiga"), [], "first owner cars");
    expect(calls[0].user).toContain('Crawl focus — the user is looking for this in particular: "first owner cars"');
    expect(x).toMatchObject({ focusMatch: true, focusNote: "Prvi vlasnik, servisna knjiga" });
    expect(x.specs.map((s) => s.key)).toEqual(["mileage_km", "first_owner"]);
  });

  it("leaves the focus out without one, and never takes matches_focus from the specs", async () => {
    const x = await extractItem(snapshot("VW Golf 7, prvi vlasnik"), []);
    expect(calls[0].user).not.toContain("Crawl focus");
    expect(x).toMatchObject({ focusMatch: null, focusNote: null });
    expect(x.specs.some((s) => s.key === "matches_focus")).toBe(false);
  });

  it("has no answer (and no quote) when the page doesn't say", async () => {
    const x = await extractItem(snapshot("VW Golf 7, 120.000 km"), [], "first owner cars");
    expect(x).toMatchObject({ focusMatch: null, focusNote: null });
  });
});

describe("collection focus", () => {
  const add = (collectionId: number, url: string, rawText: string, extra: Partial<Parameters<typeof db.upsertItem>[0]> = {}) =>
    db.upsertItem({ collectionId, url, title: url.split("/").pop()!, price: null, currency: null, mainImage: null, description: null, identity: null, specs: {}, rawText, ...extra });

  it("counts items not checked against the current focus, and a change drops the old answers", () => {
    const id = db.createCollection("Cars", "https://cars.example/list", "cars.example");
    add(id, "https://cars.example/ad/a", "prvi vlasnik", { focusFor: "first owner", focusNote: "prvi vlasnik", specs: { matches_focus: true } });
    add(id, "https://cars.example/ad/b", "drugi vlasnik");
    add(id, "https://cars.example/ad/c", ""); // no page text to check
    expect(db.getCollection(id)).toMatchObject({ focus: null, focusPendingCount: 0 });

    db.setCollectionFocus(id, "first owner");
    // Setting it drops every answer — the first item's was set before (as in an import), so it's pending too.
    expect(db.getCollection(id)?.focusPendingCount).toBe(2);
    expect(db.listItems(id, 10).every((i) => i.specs.matches_focus === undefined && i.focusNote === null)).toBe(true);
    expect(db.setCollectionFocus(id, " first owner ")).toBe(false);

    db.setCollectionFocus(id, "");
    expect(db.getCollection(id)).toMatchObject({ focus: null, focusPendingCount: 0 });
  });

  it("travels with an export", () => {
    const id = db.createCollection("Export", "https://cars.example/x", "cars.example");
    db.setCollectionFocus(id, "first owner");
    add(id, "https://cars.example/ad/x", "prvi vlasnik", { focusFor: "first owner", focusNote: "Prvi vlasnik", specs: { matches_focus: true } });
    const exported = db.exportCollection(id);
    expect(exported.collection.focus).toBe("first owner");
    expect(exported.items[0]).toMatchObject({ focusFor: "first owner", focusNote: "Prvi vlasnik" });
    const me = Number(db.getDb().prepare("INSERT INTO users (email, password_hash, role, created_at) VALUES ('export@example.com', 'x', 'user', ?)").run(Date.now()).lastInsertRowid);
    const { collectionId } = db.importCollection(exported, { id: me, role: "user" });
    expect(db.getCollection(collectionId)).toMatchObject({ focus: "first owner", focusPendingCount: 0 });
  });

  it("applying it checks the pending items from their stored page text", async () => {
    const id = db.createCollection("Apply", "https://cars.example/apply", "cars.example");
    add(id, "https://cars.example/ad/1", "Golf, prvi vlasnik, servisna knjiga");
    add(id, "https://cars.example/ad/2", "Passat, drugi vlasnik");
    add(id, "https://cars.example/ad/3", "Polo, 90.000 km");
    db.setCollectionFocus(id, "first owner cars");

    const job = await finished(startFocusCheck(id, null).id);
    expect(job).toMatchObject({ kind: "focus", status: "done", itemsFound: 3, itemsIndexed: 3, itemsFailed: 0 });
    expect(calls.map((c) => c.purpose)).toEqual(["focus", "focus", "focus"]);

    const byUrl = new Map(db.listItems(id, 10).map((i) => [i.url, i]));
    expect(byUrl.get("https://cars.example/ad/1")).toMatchObject({ focusNote: "Prvi vlasnik, servisna knjiga", specs: { matches_focus: true, first_owner: true } });
    expect(byUrl.get("https://cars.example/ad/2")).toMatchObject({ focusNote: "drugi vlasnik", specs: { matches_focus: false, first_owner: false } });
    expect(byUrl.get("https://cars.example/ad/3")?.specs.matches_focus).toBeUndefined();
    expect(byUrl.get("https://cars.example/ad/3")?.focusNote).toBeNull();
    expect(db.getCollection(id)?.focusPendingCount).toBe(0);
    expect(db.listSpecKeys(id).find((k) => k.key === "matches_focus")).toMatchObject({ type: "boolean", label: "Matches focus", count: 2 });
  });
});
