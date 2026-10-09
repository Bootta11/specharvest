import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { SECRET_MASK, notificationSettingsSchema, type Job } from "@specharvest/shared";

// config.ts reads DATA_DIR at import time — point it at a throwaway dir first.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "specharvest-notify-"));
process.env.DATA_DIR = dataDir;
delete process.env.ENCRYPTION_KEY;
delete process.env.OUTBOUND_ALLOWED_HOSTS;
delete process.env.ALLOW_PRIVATE_TARGETS;

// Outbound requests go through lib/net-guard.ts guardedFetch — record them instead of hitting the network.
const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock("../lib/net-guard.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/net-guard.ts")>()),
  guardedFetch: (...args: unknown[]) => fetchMock(...args),
}));

const db = await import("../db/sqlite.ts");
const notify = await import("./index.ts");
const channels = await import("./channels.ts");
const guard = await import("../lib/net-guard.ts");
const users = await import("../auth/users.ts");

// Name lookups for the target checks, without DNS: *.internal is on the LAN, everything else public.
guard.setResolver(async (host) => (host.endsWith(".internal") ? ["10.0.0.5"] : ["93.184.216.34"]));

const admin = await users.createUser("admin@example.com", "password1", "admin");
const member = await users.createUser("member@example.com", "password1", "user");
/** Senders' target policy in channel tests (what admins get). */
const open = { allowPrivate: true, allowHosts: [] };

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
  lookup: null,
  message: "40 new, 0 changed, 0 unchanged, 0 gone, 0 failed",
  error: null,
  startedAt: 0,
  finishedAt: 5 * 60_000,
  resumable: false,
  ...over,
});

const defaults = () => notificationSettingsSchema.parse({});

function mockFetch(impl: (url: string, init: RequestInit) => Response | Promise<Response> = () => new Response("ok")) {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => impl(String(url), init ?? {}));
  return fetchMock;
}

afterEach(() => fetchMock.mockReset());
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

  it("persists through the settings table", async () => {
    const s = defaults();
    s.ntfy = { enabled: true, server: "https://ntfy.sh", topic: "t1", token: "" };
    await notify.saveNotificationSettings(admin, s);
    expect(notify.getNotificationSettings(admin.id).ntfy.topic).toBe("t1");
    // Another user's channels are separate.
    expect(notify.getNotificationSettings(member.id).ntfy.topic).toBe("");
  });

  it("stores secrets encrypted and still reads ones saved before encryption", async () => {
    const s = defaults();
    s.telegram = { enabled: true, botToken: "123:secret-token", chatId: "42" };
    await notify.saveNotificationSettings(member, s);
    const raw = db.getSetting<{ telegram: { botToken: string; chatId: string } }>(`notifications:${member.id}`)!;
    expect(raw.telegram.botToken).toMatch(/^v1\./);
    expect(raw.telegram.botToken).not.toContain("secret-token");
    expect(raw.telegram.chatId).toBe("42");
    expect(notify.getNotificationSettings(member.id).telegram.botToken).toBe("123:secret-token");

    db.setSetting(`notifications:${member.id}`, { telegram: { enabled: true, botToken: "123:plain", chatId: "1" } });
    expect(notify.getNotificationSettings(member.id).telegram.botToken).toBe("123:plain");
    db.deleteSetting(`notifications:${member.id}`);
  });
});

describe("channels", () => {
  const msg = notify.buildMessage(job({ status: "failed", error: "Bot wall — ž" }), "shop", "https://sh.example");

  it("ntfy posts to server/topic with headers", async () => {
    const f = mockFetch();
    await channels.sendNtfy({ enabled: true, server: "https://ntfy.example/", topic: "my topic", token: "tk" }, msg, open);
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
    await channels.sendNtfy({ enabled: true, server: "https://ntfy.sh", topic: "t", token: "" }, { ...msg, title: "Crawl done" }, open);
    expect((f.mock.calls[0][1]!.headers as Record<string, string>).Title).toBe("Crawl done");
  });

  it("telegram sends MarkdownV2 to the bot API", async () => {
    const f = mockFetch();
    await channels.sendTelegram({ enabled: true, botToken: "123:abc", chatId: "42" }, msg, open);
    const [url, init] = f.mock.calls[0];
    expect(url).toBe("https://api.telegram.org/bot123:abc/sendMessage");
    const body = JSON.parse(String(init!.body));
    expect(body.chat_id).toBe("42");
    expect(body.parse_mode).toBe("MarkdownV2");
    expect(body.text).toContain("Bot wall — ž");
  });

  it("discord gets {content}, slack gets {text}", async () => {
    const f = mockFetch();
    await channels.sendDiscord({ enabled: true, webhookUrl: "https://discord.com/api/webhooks/1/x" }, msg, open);
    await channels.sendDiscord({ enabled: true, webhookUrl: "https://hooks.slack.com/services/x" }, msg, open);
    expect(JSON.parse(String(f.mock.calls[0][1]!.body))).toHaveProperty("content");
    expect(JSON.parse(String(f.mock.calls[1][1]!.body))).toHaveProperty("text");
  });

  it("apprise posts urls, title and type to /notify/", async () => {
    const f = mockFetch();
    await channels.sendApprise({ enabled: true, apiUrl: "http://apprise:8000/", urls: "ntfy://a\ntgram://b/c" }, msg, open);
    const [url, init] = f.mock.calls[0];
    expect(url).toBe("http://apprise:8000/notify/");
    expect(JSON.parse(String(init!.body))).toMatchObject({ urls: "ntfy://a,tgram://b/c", type: "failure", title: "Crawl failed · shop" });
  });

  it("surfaces HTTP errors", async () => {
    mockFetch(() => new Response("unauthorized", { status: 401 }));
    await expect(channels.sendWebhook({ enabled: true, url: "https://x.example" }, msg, open)).rejects.toThrow("HTTP 401: unauthorized");
  });

  it("one failing channel doesn't stop the others", async () => {
    const f = mockFetch((url) => (url.includes("ntfy") ? new Response("down", { status: 500 }) : new Response("ok")));
    const s = defaults();
    s.ntfy = { enabled: true, server: "https://ntfy.sh", topic: "t", token: "" };
    s.webhook = { enabled: true, url: "https://hook.example" };
    const errors = await notify.dispatch(s, msg, notify.enabledChannels(s, 0), admin.id);
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
    await notify.saveNotificationSettings(admin, s);
    await notify.notifyJobFinished(job({ kind: "enrich", userId: admin.id }));
    expect(f).not.toHaveBeenCalled();
    await notify.notifyJobFinished(job({ userId: admin.id }));
    expect(f).toHaveBeenCalledTimes(1);
    await notify.notifyJobFinished(job({ status: "running", userId: admin.id }));
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("only uses the job owner's channels", async () => {
    const f = mockFetch();
    const s = defaults();
    s.webhook = { enabled: true, url: "https://hook.example" };
    await notify.saveNotificationSettings(admin, s);
    await notify.notifyJobFinished(job({ userId: member.id }));
    await notify.notifyJobFinished(job({ userId: null }));
    expect(f).not.toHaveBeenCalled();
  });
});

describe("where notifications may go", () => {
  const save = (user: typeof admin, patch: (s: ReturnType<typeof defaults>) => void) => {
    const s = defaults();
    patch(s);
    return notify.saveNotificationSettings(user, s);
  };

  it("keeps non-admins' channels off private addresses; admins may use them", async () => {
    for (const url of ["http://10.0.0.5/hook", "http://nas.internal/hook", "http://localhost:8080/x", "http://[::1]/x"]) {
      await expect(save(member, (s) => (s.webhook = { enabled: true, url }))).rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/^Webhook URL: .*private or local/) });
      await expect(save(admin, (s) => (s.webhook = { enabled: true, url }))).resolves.toBeTruthy();
    }
    await expect(save(member, (s) => (s.webhook = { enabled: true, url: "https://hooks.example.com/x" }))).resolves.toBeTruthy();
    await expect(save(member, (s) => (s.webhook = { enabled: true, url: "file:///etc/passwd" }))).rejects.toMatchObject({ statusCode: 400 });
    // Disabled channels aren't checked (the default Apprise URL, a URL being typed in).
    await expect(save(member, (s) => (s.webhook = { enabled: false, url: "http://10.0.0.5/hook" }))).resolves.toBeTruthy();
  });

  it("lets everyone use OUTBOUND_ALLOWED_HOSTS (the bundled Apprise), but not Apprise's forward-anywhere URLs", async () => {
    await expect(save(member, (s) => (s.apprise = { enabled: true, apiUrl: "http://apprise:8000", urls: "tgram://bot/chat" }))).resolves.toBeTruthy();
    await expect(save(member, (s) => (s.apprise = { enabled: true, apiUrl: "http://apprise:8000", urls: "json://10.0.0.1/x" }))).rejects.toThrow(/only admins/);
    await expect(save(member, (s) => (s.apprise = { enabled: true, apiUrl: "http://apprise:8000", urls: "ntfy://127.0.0.1/topic" }))).rejects.toThrow(/private or local/);
    await expect(save(admin, (s) => (s.apprise = { enabled: true, apiUrl: "http://apprise:8000", urls: "json://10.0.0.1/x" }))).resolves.toBeTruthy();
    expect(channels.appriseUrlProblem("discord://webhook_id/webhook_token")).toBeNull();
  });

  it("sends with the channel owner's policy", async () => {
    const f = mockFetch();
    const s = defaults();
    s.webhook = { enabled: true, url: "https://hook.example" };
    const msg = notify.buildMessage(job(), null, undefined);
    await notify.dispatch(s, msg, ["webhook"], member.id);
    await notify.dispatch(s, msg, ["webhook"], admin.id);
    expect(f.mock.calls.map((c) => (c[2] as { allowPrivate: boolean }).allowPrivate)).toEqual([false, true]);
  });
});
