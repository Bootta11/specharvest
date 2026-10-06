import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { SECRET_MASK, notificationSettingsSchema, type Job } from "@specharvest/shared";

// config.ts reads DATA_DIR at import time — point it at a throwaway dir first.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "specharvest-notify-"));
process.env.DATA_DIR = dataDir;
const db = await import("../db/sqlite.ts");
const notify = await import("./index.ts");
const channels = await import("./channels.ts");

const job = (over: Partial<Job> = {}): Job => ({
  id: 7,
  collectionId: null,
  userId: 1,
  kind: "crawl",
  status: "done",
  pagesSeen: 3,
  itemsFound: 40,
  itemsIndexed: 40,
  itemsFailed: 0,
  webSearches: 0,
  llmCost: 0.0042,
  itemsRemaining: 0,
  message: "40 new, 0 changed, 0 unchanged, 0 gone, 0 failed",
  error: null,
  startedAt: 0,
  finishedAt: 5 * 60_000,
  resumable: false,
  ...over,
});

const defaults = () => notificationSettingsSchema.parse({});

function mockFetch(impl: (url: string, init: RequestInit) => Response | Promise<Response> = () => new Response("ok")) {
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => impl(String(url), init ?? {}));
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => vi.unstubAllGlobals());
afterAll(() => {
  db.getDb().close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("buildMessage", () => {
  it("describes a finished crawl with summary, duration, cost and link", () => {
    const m = notify.buildMessage(job(), "mobile.de — BMW", "https://sh.example");
    expect(m.event).toBe("crawlDone");
    expect(m.title).toBe("Crawl done · mobile.de — BMW");
    expect(m.body).toContain("40 new");
    expect(m.body).toContain("5 min");
    expect(m.body).toContain("$0.0042 LLM");
    expect(m.url).toBe("https://sh.example/?job=7");
  });

  it("uses the error for failures and omits the link without PUBLIC_URL", () => {
    const m = notify.buildMessage(job({ status: "failed", error: "No item links found" }), null, undefined);
    expect(m.event).toBe("crawlFailed");
    expect(m.title).toBe("Crawl failed");
    expect(m.body).toContain("No item links found");
    expect(notify.buildMessage(job({ finishedAt: 4_000 }), null, undefined).body).toContain("4 s");
    expect(m.url).toBeNull();
  });

  it("labels web lookups", () => {
    expect(notify.buildMessage(job({ kind: "enrich" }), null, undefined).title).toBe("Web lookup done");
  });
});

describe("settings secrets", () => {
  it("masks secrets and keeps stored values when the mask comes back", () => {
    const stored = defaults();
    stored.telegram = { enabled: true, botToken: "123:abc", chatId: "42" };
    stored.ntfy.token = "tk_secret";
    const masked = notify.maskSettings(stored);
    expect(masked.telegram.botToken).toBe(SECRET_MASK);
    expect(masked.telegram.chatId).toBe("42");
    expect(masked.ntfy.token).toBe(SECRET_MASK);
    expect(masked.discord.webhookUrl).toBe(""); // empty stays empty, not masked

    const merged = notify.mergeSettings(stored, { ...masked, telegram: { ...masked.telegram, chatId: "43" } });
    expect(merged.telegram.botToken).toBe("123:abc");
    expect(merged.telegram.chatId).toBe("43");
    expect(merged.ntfy.token).toBe("tk_secret");
  });

  it("persists through the settings table", () => {
    const s = defaults();
    s.ntfy = { enabled: true, server: "https://ntfy.sh", topic: "t1", token: "" };
    notify.saveNotificationSettings(1, s);
    expect(notify.getNotificationSettings(1).ntfy.topic).toBe("t1");
    // Another user's channels are separate.
    expect(notify.getNotificationSettings(2).ntfy.topic).toBe("");
  });
});

describe("channels", () => {
  const msg = notify.buildMessage(job({ status: "failed", error: "Bot wall — ž" }), "shop", "https://sh.example");

  it("ntfy posts to server/topic with headers", async () => {
    const f = mockFetch();
    await channels.sendNtfy({ enabled: true, server: "https://ntfy.example/", topic: "my topic", token: "tk" }, msg);
    const [url, init] = f.mock.calls[0];
    expect(url).toBe("https://ntfy.example/my%20topic");
    const h = init!.headers as Record<string, string>;
    expect(Buffer.from(h.Title.replace(/^=\?UTF-8\?B\?|\?=$/g, ""), "base64").toString()).toBe("Crawl failed · shop");
    expect(h.Priority).toBe("high");
    expect(h.Click).toBe("https://sh.example/?job=7");
    expect(h.Authorization).toBe("Bearer tk");
  });

  it("ntfy sends ASCII titles as-is", async () => {
    const f = mockFetch();
    await channels.sendNtfy({ enabled: true, server: "https://ntfy.sh", topic: "t", token: "" }, { ...msg, title: "Crawl done" });
    expect((f.mock.calls[0][1]!.headers as Record<string, string>).Title).toBe("Crawl done");
  });

  it("telegram sends MarkdownV2 to the bot API", async () => {
    const f = mockFetch();
    await channels.sendTelegram({ enabled: true, botToken: "123:abc", chatId: "42" }, msg);
    const [url, init] = f.mock.calls[0];
    expect(url).toBe("https://api.telegram.org/bot123:abc/sendMessage");
    const body = JSON.parse(String(init!.body));
    expect(body.chat_id).toBe("42");
    expect(body.parse_mode).toBe("MarkdownV2");
    expect(body.text).toContain("Bot wall — ž");
  });

  it("discord gets {content}, slack gets {text}", async () => {
    const f = mockFetch();
    await channels.sendDiscord({ enabled: true, webhookUrl: "https://discord.com/api/webhooks/1/x" }, msg);
    await channels.sendDiscord({ enabled: true, webhookUrl: "https://hooks.slack.com/services/x" }, msg);
    expect(JSON.parse(String(f.mock.calls[0][1]!.body))).toHaveProperty("content");
    expect(JSON.parse(String(f.mock.calls[1][1]!.body))).toHaveProperty("text");
  });

  it("apprise posts urls, title and type to /notify/", async () => {
    const f = mockFetch();
    await channels.sendApprise({ enabled: true, apiUrl: "http://apprise:8000/", urls: "ntfy://a\ntgram://b/c" }, msg);
    const [url, init] = f.mock.calls[0];
    expect(url).toBe("http://apprise:8000/notify/");
    expect(JSON.parse(String(init!.body))).toMatchObject({ urls: "ntfy://a,tgram://b/c", type: "failure", title: "Crawl failed · shop" });
  });

  it("surfaces HTTP errors", async () => {
    mockFetch(() => new Response("unauthorized", { status: 401 }));
    await expect(channels.sendWebhook({ enabled: true, url: "https://x.example" }, msg)).rejects.toThrow("HTTP 401: unauthorized");
  });

  it("one failing channel doesn't stop the others", async () => {
    const f = mockFetch((url) => (url.includes("ntfy") ? new Response("down", { status: 500 }) : new Response("ok")));
    const s = defaults();
    s.ntfy = { enabled: true, server: "https://ntfy.sh", topic: "t", token: "" };
    s.webhook = { enabled: true, url: "https://hook.example" };
    const errors = await notify.dispatch(s, msg, notify.enabledChannels(s, 0), 1);
    expect(Object.keys(errors)).toEqual(["ntfy"]);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("enabledChannels adds push only when a browser subscribed", () => {
    const s = defaults();
    s.discord.enabled = true;
    expect(notify.enabledChannels(s, 0)).toEqual(["discord"]);
    expect(notify.enabledChannels(s, 2)).toEqual(["discord", "push"]);
  });
});

describe("notifyJobFinished", () => {
  it("respects event toggles", async () => {
    const f = mockFetch();
    const s = defaults();
    s.webhook = { enabled: true, url: "https://hook.example" };
    s.events.enrichDone = false;
    notify.saveNotificationSettings(1, s);
    await notify.notifyJobFinished(job({ kind: "enrich" }));
    expect(f).not.toHaveBeenCalled();
    await notify.notifyJobFinished(job());
    expect(f).toHaveBeenCalledTimes(1);
    await notify.notifyJobFinished(job({ status: "running" }));
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("only uses the job owner's channels", async () => {
    const f = mockFetch();
    const s = defaults();
    s.webhook = { enabled: true, url: "https://hook.example" };
    notify.saveNotificationSettings(1, s);
    await notify.notifyJobFinished(job({ userId: 2 }));
    await notify.notifyJobFinished(job({ userId: null }));
    expect(f).not.toHaveBeenCalled();
  });
});
