import type { Job, NotificationSettings } from "@specharvest/shared";

export type NotifyEvent = "crawlDone" | "crawlFailed" | "enrichDone" | "enrichFailed" | "test";

export interface NotifyMessage {
  event: NotifyEvent;
  title: string;
  body: string;
  /** Deep link into the app, when PUBLIC_URL is set. */
  url: string | null;
  job: Job | null;
  collection: string | null;
}

const TIMEOUT_MS = 10_000;

async function post(url: string, init: { headers?: Record<string, string>; body: string; json?: boolean }) {
  const res = await fetch(url, {
    method: "POST",
    headers: { ...(init.json ? { "Content-Type": "application/json" } : {}), ...init.headers },
    body: init.body,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = (await res.text().catch(() => "")).slice(0, 200);
    throw new Error(`HTTP ${res.status}${text ? `: ${text}` : ""}`);
  }
}

const failed = (m: NotifyMessage) => m.event === "crawlFailed" || m.event === "enrichFailed";

/** HTTP header values must be Latin-1; ntfy decodes RFC 2047 encoded words. */
const headerSafe = (v: string) => (/^[\x20-\x7e]*$/.test(v) ? v : `=?UTF-8?B?${Buffer.from(v).toString("base64")}?=`);

export async function sendNtfy(cfg: NotificationSettings["ntfy"], m: NotifyMessage) {
  if (!cfg.topic) throw new Error("ntfy topic is not set");
  const headers: Record<string, string> = {
    Title: headerSafe(m.title),
    Tags: failed(m) ? "warning" : "white_check_mark",
    Priority: failed(m) ? "high" : "default",
  };
  if (m.url) headers.Click = m.url;
  if (cfg.token) headers.Authorization = `Bearer ${cfg.token}`;
  await post(`${(cfg.server || "https://ntfy.sh").replace(/\/+$/, "")}/${encodeURIComponent(cfg.topic)}`, { headers, body: m.body });
}

export async function sendTelegram(cfg: NotificationSettings["telegram"], m: NotifyMessage) {
  if (!cfg.botToken || !cfg.chatId) throw new Error("Telegram bot token and chat id are required");
  const text = [`*${escapeMd(m.title)}*`, escapeMd(m.body), m.url ? escapeMd(m.url) : null].filter(Boolean).join("\n");
  await post(`https://api.telegram.org/bot${cfg.botToken}/sendMessage`, {
    json: true,
    body: JSON.stringify({ chat_id: cfg.chatId, text, parse_mode: "MarkdownV2", disable_web_page_preview: true }),
  });
}

const escapeMd = (s: string) => s.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, "\\$&");

export async function sendDiscord(cfg: NotificationSettings["discord"], m: NotifyMessage) {
  if (!cfg.webhookUrl) throw new Error("Webhook URL is not set");
  const text = [`**${m.title}**`, m.body, m.url].filter(Boolean).join("\n");
  // Slack incoming webhooks take {text}; Discord takes {content}.
  const slack = /hooks\.slack\.com/.test(cfg.webhookUrl);
  await post(cfg.webhookUrl, { json: true, body: JSON.stringify(slack ? { text: text.replace(/\*\*/g, "*") } : { content: text }) });
}

export async function sendWebhook(cfg: NotificationSettings["webhook"], m: NotifyMessage) {
  if (!cfg.url) throw new Error("Webhook URL is not set");
  await post(cfg.url, {
    json: true,
    body: JSON.stringify({ event: m.event, title: m.title, body: m.body, url: m.url, collection: m.collection, job: m.job }),
  });
}

export async function sendApprise(cfg: NotificationSettings["apprise"], m: NotifyMessage) {
  if (!cfg.apiUrl) throw new Error("Apprise API URL is not set");
  if (!cfg.urls) throw new Error("No Apprise URLs set");
  await post(`${cfg.apiUrl.replace(/\/+$/, "")}/notify/`, {
    json: true,
    body: JSON.stringify({
      urls: cfg.urls.split(/[\s,]+/).filter(Boolean).join(","),
      title: m.title,
      body: m.url ? `${m.body}\n${m.url}` : m.body,
      type: failed(m) ? "failure" : m.event === "test" ? "info" : "success",
    }),
  });
}
