import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import type { WebSocket } from "ws";
import { EXTENSION_PROTOCOL, type ExtensionServerMessage } from "@specharvest/shared";

// config.ts reads DATA_DIR at import time — point it at a throwaway dir first.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "specharvest-ext-"));
process.env.DATA_DIR = dataDir;
await import("../db/sqlite.ts");
const users = await import("../auth/users.ts");
const sessions = await import("../auth/sessions.ts");
const apiKeys = await import("../auth/api-keys.ts");
const { registerAuth, SESSION_COOKIE } = await import("../auth/plugin.ts");
const { errorHandler } = await import("../lib/http-error.ts");
const { registerExtensionGateway, extensionStatus } = await import("./gateway.ts");
const { registerExtensionRoutes } = await import("./routes.ts");
const { withExtensionPage, prepareBrowserRunner } = await import("./driver.ts");
const { FatalDriverError } = await import("../crawler/driver.ts");
const { walkListing } = await import("../crawler/paginate.ts");
const { default: Fastify } = await import("fastify");

afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }));

const app = Fastify();
await registerAuth(app);
app.setErrorHandler(errorHandler);
await registerExtensionGateway(app);
registerExtensionRoutes(app);
app.get("/api/jobs", async () => []);
app.get("/api/api-keys", async () => []);
await app.ready();

const user = await users.createUser("ext@example.com", "password1");
const cookie = `${SESSION_COOKIE}=${sessions.createSession(user.id).rawToken}`;

/** Returned by a handler: don't answer this command at all. */
const SILENT = Symbol("silent");

type Handler = (cmd: Extract<ExtensionServerMessage, { type: "command" }>["command"], id: number, ws: WebSocket) => unknown;

/** A fake extension: says hello, then answers commands with `handle` (a thrown value → error reply). */
async function connect(token: string, handle: Handler = () => null, hello: { autoVisible?: boolean } = {}) {
  const ws = await app.injectWS("/api/extension/ws");
  const messages: ExtensionServerMessage[] = [];
  ws.on("message", (data) => {
    const msg = JSON.parse(data.toString()) as ExtensionServerMessage;
    messages.push(msg);
    if (msg.type !== "command") return;
    try {
      const result = handle(msg.command, msg.id, ws);
      if (result === SILENT) return;
      ws.send(JSON.stringify({ type: "reply", id: msg.id, ok: true, result: result ?? null }));
    } catch (err) {
      const e = err as { code: string; message: string; origin?: string };
      ws.send(JSON.stringify({ type: "reply", id: msg.id, ok: false, code: e.code, message: e.message, origin: e.origin }));
    }
  });
  ws.send(JSON.stringify({ type: "hello", token, protocol: EXTENSION_PROTOCOL, version: "0.1.0", concurrency: 2, ...hello }));
  await until(() => messages.some((m) => m.type === "welcome" || m.type === "bye"));
  return { ws, messages };
}

async function until(cond: () => boolean, ms = 2000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("extension tokens", () => {
  const { token } = apiKeys.createExtensionToken(user.id, "Work laptop", "token");

  it("only reach the extension's endpoints", async () => {
    const get = (url: string) => app.inject({ method: "GET", url, headers: { "x-api-key": token } });
    expect((await get("/api/jobs")).statusCode).toBe(200);
    expect((await get("/api/extension/whoami")).json()).toEqual({ email: "ext@example.com", deviceName: "Work laptop" });
    expect((await get("/api/api-keys")).statusCode).toBe(403);
    expect((await get("/api/extension/devices")).statusCode).toBe(403);
  });

  it("aren't listed as API keys, and a revoked one stops working", async () => {
    expect(apiKeys.listApiKeys(user.id)).toEqual([]);
    const created = apiKeys.createExtensionToken(user.id, "Temp", "token");
    expect(apiKeys.verifyKey(created.token)?.kind).toBe("extension");
    const res = await app.inject({ method: "DELETE", url: `/api/extension/devices/${created.device.id}`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(apiKeys.verifyKey(created.token)).toBeNull();
  });
});

describe("pairing by approval", () => {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const claim = () => app.inject({ method: "POST", url: "/api/extension/pair/claim", payload: { verifier } });

  it("hands out a token once, only after a signed-in user approved", async () => {
    expect((await claim()).statusCode).toBe(202);
    const viaKey = await app.inject({
      method: "POST",
      url: "/api/extension/pair/approve",
      headers: { "x-api-key": apiKeys.createApiKey(user.id, "script").key },
      payload: { challenge, deviceName: "Home" },
    });
    expect(viaKey.statusCode).toBe(403);
    const ok = await app.inject({ method: "POST", url: "/api/extension/pair/approve", headers: { cookie }, payload: { challenge, deviceName: "Home" } });
    expect(ok.statusCode).toBe(200);
    const first = await claim();
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ email: "ext@example.com", deviceName: "Home" });
    expect(apiKeys.verifyKey(first.json().token)?.userId).toBe(user.id);
    expect((await claim()).statusCode).toBe(202);
    expect(apiKeys.listExtensionTokens(user.id).find((d) => d.name === "Home")?.via).toBe("approve");
  });
});

describe("gateway", () => {
  it("refuses a bad token", async () => {
    const { messages } = await connect("shx_not-a-real-token");
    expect(messages.at(-1)).toMatchObject({ type: "bye", code: "bad_token" });
    expect(extensionStatus(user.id).online).toBe(false);
  });

  it("drives tabs and reports status", async () => {
    const { token } = apiKeys.createExtensionToken(user.id, "Desk", "token");
    const ops: string[] = [];
    const { ws, messages } = await connect(token, (cmd) => {
      ops.push(cmd.op);
      if (cmd.op === "openTab") return { tabId: 7 };
      if (cmd.op === "goto") return { status: 200 };
      if (cmd.op === "run" && cmd.script === "pageInfo") return { url: "https://shop.example/", title: "Shop" };
      return null;
    });
    expect(messages[0]).toMatchObject({ type: "welcome", email: "ext@example.com", deviceName: "Desk" });
    expect(extensionStatus(user.id)).toMatchObject({ online: true, deviceName: "Desk", concurrency: 2 });
    const title = await withExtensionPage(user.id, async (page) => {
      expect(await page.goto("https://shop.example/", { timeoutMs: 1000 })).toEqual({ status: 200 });
      return (await page.run("pageInfo")).title;
    });
    expect(title).toBe("Shop");
    expect(ops).toEqual(["openTab", "goto", "run", "closeTab"]);
    ws.terminate();
    await until(() => !extensionStatus(user.id).online);
  });

  it("waits for a site permission, then goes on", async () => {
    const { token } = apiKeys.createExtensionToken(user.id, "Perm", "token");
    let granted = false;
    const notices: string[] = [];
    const { ws } = await connect(token, (cmd, _id, socket) => {
      if (cmd.op !== "ensurePermission") return null;
      if (granted) return { granted: true };
      // The user clicks "Allow" a moment later.
      setTimeout(() => {
        granted = true;
        socket.send(JSON.stringify({ type: "permissionGranted", origin: cmd.origin }));
      }, 30);
      throw { code: "needs_permission", message: "Not allowed yet", origin: cmd.origin };
    });
    await prepareBrowserRunner(user.id, "https://www.shop.example/list", { notice: (m) => notices.push(m) });
    expect(notices[0]).toContain("allow the SpecHarvest extension on shop.example");
    ws.terminate();
  });

  it("reads a lost tab followed by a lost connection as the browser going away", async () => {
    const { token } = apiKeys.createExtensionToken(user.id, "Quit", "token");
    const { ws } = await connect(token, (cmd) => {
      if (cmd.op === "openTab") return { tabId: 3 };
      if (cmd.op === "goto") {
        // Chrome closes its tabs first, then the extension's socket goes.
        setTimeout(() => ws.terminate(), 20);
        throw { code: "tab_closed", message: "The crawl tab was closed" };
      }
      return null;
    });
    const work = withExtensionPage(user.id, (page) => page.goto("https://shop.example/a", { timeoutMs: 1000 }));
    await expect(work).rejects.toBeInstanceOf(FatalDriverError);
  });

  it("stops waiting for a permission when the job is stopped", async () => {
    const { token } = apiKeys.createExtensionToken(user.id, "Stop", "token");
    const { ws } = await connect(token, (cmd) => (cmd.op === "ensurePermission" ? { granted: false } : null));
    const controller = new AbortController();
    const waiting = prepareBrowserRunner(user.id, "https://shop.example/", { signal: controller.signal });
    setTimeout(() => controller.abort(), 30);
    await expect(waiting).rejects.toThrow("Stopped");
    ws.terminate();
  });

  it("fails pending work when the browser goes away", async () => {
    const { token } = apiKeys.createExtensionToken(user.id, "Gone", "token");
    const { ws } = await connect(token, (cmd) => (cmd.op === "openTab" ? { tabId: 1 } : SILENT));
    const work = withExtensionPage(user.id, async (page) => {
      // The fake extension never answers — the socket closes instead.
      setTimeout(() => ws.terminate(), 30);
      return page.run("pageHtml");
    });
    await expect(work).rejects.toBeInstanceOf(FatalDriverError);
    await expect(withExtensionPage(user.id, async () => 1)).rejects.toBeInstanceOf(FatalDriverError);
  });
});

describe("data read in a user's browser", async () => {
  const db = await import("../db/sqlite.ts");
  const other = await users.createUser("other@example.com", "password1");
  const mine = db.createCollection("Mine", "https://shop.example/a", "shop.example", user.id);
  const mineToo = db.createCollection("Mine too", "https://shop.example/b", "shop.example", user.id);
  const theirs = db.createCollection("Theirs", "https://shop.example/c", "shop.example", other.id);
  const item = { url: "https://shop.example/item/1", title: "Golf", price: 1, currency: "EUR", mainImage: null, description: null, identity: "vw golf", specs: { power_kw: 81 }, rawText: "x", contentHash: "h1" };

  it("is reused only in the same user's collections", () => {
    db.upsertItem({ ...item, collectionId: mine, fromBrowser: true });
    expect(db.findReusableExtraction(item.url, "h1", mineToo, user.id)?.title).toBe("Golf");
    expect(db.findReusableExtraction(item.url, "h1", theirs, other.id)).toBeNull();
    expect(db.findPageValue(["vw golf"], "power_kw")).toBeNull();
    // Once the server reads it itself, everyone may reuse it.
    db.upsertItem({ ...item, collectionId: mine });
    expect(db.findReusableExtraction(item.url, "h1", theirs, other.id)?.title).toBe("Golf");
  });

  it("doesn't teach other collections the site's listing structure", () => {
    const detection = { listItemSelector: ".card", paginationType: "pages" as const, itemUrlPattern: null };
    db.saveDetection(mine, detection, true);
    expect(db.findDetectionForHost("shop.example", theirs)).toBeNull();
    db.saveDetection(mine, detection);
    expect(db.findDetectionForHost("shop.example", theirs)?.listItemSelector).toBe(".card");
  });
});

describe("sites that load items on scroll", () => {
  const detection = (paginationType: "infiniteScroll" | "urlPage" | "pages") => ({
    listItemSelector: ".card",
    paginationType,
    nextSelector: null,
    itemUrlPattern: null,
    ...(paginationType === "urlPage" ? { pageParam: "page" } : {}),
  });

  /** A fake extension tab for a listing with no cards: records the commands it gets. */
  async function walk(paginationType: "infiniteScroll" | "urlPage" | "pages", autoVisible: boolean) {
    const { token } = apiKeys.createExtensionToken(user.id, `Scroll ${paginationType} ${autoVisible}`, "token");
    const ops: string[] = [];
    const { ws } = await connect(
      token,
      (cmd) => {
        ops.push(cmd.op === "run" ? `run:${cmd.script}` : cmd.op);
        if (cmd.op === "openTab") return { tabId: 5 };
        if (cmd.op === "goto") return { status: 200 };
        if (cmd.op === "showTab") return { moved: true, visible: true };
        if (cmd.op === "run") return cmd.script === "collectCards" ? [] : cmd.script === "scrollStep" ? true : false;
        return null;
      },
      { autoVisible },
    );
    const notices: Array<[string, boolean]> = [];
    // A public IP literal: the URL guard needs no DNS lookup.
    const result = await withExtensionPage(
      user.id,
      (page) => walkListing(page, "https://93.184.216.34/list", detection(paginationType), { maxPages: 2, maxItems: 10, onPage: () => {}, onNotice: (m, w) => notices.push([m, w]) }),
      { origin: "https://93.184.216.34" },
    );
    ws.terminate();
    await until(() => !extensionStatus(user.id).online);
    return { ops, notices, complete: result.complete };
  }

  it("moves an infinite-scroll listing's tab to a visible window", async () => {
    const { ops, notices, complete } = await walk("infiniteScroll", true);
    expect(complete).toBe(true);
    expect(ops[0]).toBe("openTab");
    expect(ops.filter((o) => o === "showTab")).toHaveLength(1);
    expect(ops.indexOf("showTab")).toBeLessThan(ops.indexOf("run:collectCards"));
    expect(notices).toEqual([[expect.stringContaining("moved the crawl to a background window"), false]]);
  });

  it("leaves paged listings where they are", async () => {
    for (const type of ["urlPage", "pages"] as const) {
      const { ops, notices } = await walk(type, true);
      expect(ops).not.toContain("showTab");
      expect(notices).toEqual([]);
    }
  });

  it("asks the extension to check a listing once, and reports what it found", async () => {
    for (const [autoVisible, answer, expected] of [
      [true, { checked: true, needsVisible: true }, /loads more items as you scroll/],
      [true, { checked: true, needsVisible: false }, /don't need a visible window/],
      [true, { checked: false, needsVisible: false }, null],
      [false, null, null],
    ] as const) {
      const { token } = apiKeys.createExtensionToken(user.id, `Probe ${autoVisible} ${JSON.stringify(answer)}`, "token");
      const ops: string[] = [];
      const { ws } = await connect(
        token,
        (cmd) => {
          ops.push(cmd.op);
          return cmd.op === "openTab" ? { tabId: 2 } : cmd.op === "probeScroll" ? answer : null;
        },
        { autoVisible },
      );
      const r = await withExtensionPage(user.id, (page) => page.checkScrollLoading!("https://shop.example/list"));
      if (expected) expect(r.message).toMatch(expected);
      else expect(r.message).toBeNull();
      expect(r.loadsOnScroll).toBe(!!answer?.needsVisible);
      expect(ops.includes("probeScroll")).toBe(autoVisible);
      ws.terminate();
      await until(() => !extensionStatus(user.id).online);
    }
  });

  it("warns instead when the user keeps crawl windows minimized", async () => {
    const { ops, notices, complete } = await walk("infiniteScroll", false);
    expect(ops).not.toContain("showTab");
    // Items it couldn't scroll to must not be taken as gone.
    expect(complete).toBe(false);
    expect(notices).toEqual([[expect.stringContaining("may miss items"), true]]);
  });
});
