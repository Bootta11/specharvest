import net from "node:net";
import type { Job, NotificationSettings } from "@specharvest/shared";
import { guardedFetch, isPrivateAddress, type TargetPolicy } from "../lib/net-guard.ts";

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

/** POST to a user-supplied URL: private addresses only as `policy` allows, no redirects (lib/net-guard.ts). */
async function post(url: string, init: { headers?: Record<string, string>; body: string; json?: boolean }, policy: TargetPolicy) {
  const res = await guardedFetch(
    url,
    {
      method: "POST",
      headers: { ...(init.json ? { "Content-Type": "application/json" } : {}), ...init.headers },
      body: init.body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    },
    policy,
  );
  if (!res.ok) {
    const text = (await res.text().catch(() => "")).slice(0, 200);
    throw new Error(`HTTP ${res.status}${text ? `: ${text}` : ""}`);
  }
}

const failed = (m: NotifyMessage) => m.event === "crawlFailed" || m.event === "enrichFailed";

/** HTTP header values must be Latin-1; ntfy decodes RFC 2047 encoded words. */
const headerSafe = (v: string) => (/^[\x20-\x7e]*$/.test(v) ? v : `=?UTF-8?B?${Buffer.from(v).toString("base64")}?=`);

export async function sendNtfy(cfg: NotificationSettings["ntfy"], m: NotifyMessage, policy: TargetPolicy) {
  if (!cfg.topic) throw new Error("ntfy topic is not set");
  const headers: Record<string, string> = {
    Title: headerSafe(m.title),
    Tags: failed(m) ? "warning" : "white_check_mark",
    Priority: failed(m) ? "high" : "default",
  };
  if (m.url) headers.Click = m.url;
  if (cfg.token) headers.Authorization = `Bearer ${cfg.token}`;
  await post(`${(cfg.server || "https://ntfy.sh").replace(/\/+$/, "")}/${encodeURIComponent(cfg.topic)}`, { headers, body: m.body }, policy);
}

export async function sendTelegram(cfg: NotificationSettings["telegram"], m: NotifyMessage, policy: TargetPolicy) {
  if (!cfg.botToken || !cfg.chatId) throw new Error("Telegram bot token and chat id are required");
  const text = [`*${escapeMd(m.title)}*`, escapeMd(m.body), m.url ? escapeMd(m.url) : null].filter(Boolean).join("\n");
  await post(
    `https://api.telegram.org/bot${cfg.botToken}/sendMessage`,
    { json: true, body: JSON.stringify({ chat_id: cfg.chatId, text, parse_mode: "MarkdownV2", disable_web_page_preview: true }) },
    policy,
  );
}

const escapeMd = (s: string) => s.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, "\\$&");

export async function sendDiscord(cfg: NotificationSettings["discord"], m: NotifyMessage, policy: TargetPolicy) {
  if (!cfg.webhookUrl) throw new Error("Webhook URL is not set");
  const text = [`**${m.title}**`, m.body, m.url].filter(Boolean).join("\n");
  // Slack incoming webhooks take {text}; Discord takes {content}.
  const slack = /hooks\.slack\.com/.test(cfg.webhookUrl);
  await post(cfg.webhookUrl, { json: true, body: JSON.stringify(slack ? { text: text.replace(/\*\*/g, "*") } : { content: text }) }, policy);
}

export async function sendWebhook(cfg: NotificationSettings["webhook"], m: NotifyMessage, policy: TargetPolicy) {
  if (!cfg.url) throw new Error("Webhook URL is not set");
  await post(
    cfg.url,
    { json: true, body: JSON.stringify({ event: m.event, title: m.title, body: m.body, url: m.url, collection: m.collection, job: m.job }) },
    policy,
  );
}

/** Apprise schemes that send to any URL — through the Apprise container, i.e. from inside its network. */
const APPRISE_FORWARDERS = /^(json|jsons|xml|xmls|form|forms|apprise|apprises):\/\//i;

/**
 * Why a user who may not reach private addresses can't use this Apprise URL (null = fine): a generic
 * forwarder, or a service URL whose host is local. Other hosts in Apprise URLs are often tokens, not names.
 */
export function appriseUrlProblem(raw: string): string | null {
  const forwarder = raw.match(APPRISE_FORWARDERS);
  if (forwarder) return `${forwarder[1].toLowerCase()}:// URLs can reach any address — only admins can use them`;
  let host = "";
  try {
    host = new URL(raw).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  } catch {
    return null;
  }
  if (host === "localhost" || host.endsWith(".localhost") || (net.isIP(host) && isPrivateAddress(host))) return `${host} is a private or local network address`;
  return null;
}

export const appriseUrls = (urls: string) => urls.split(/[\s,]+/).filter(Boolean);

export async function sendApprise(cfg: NotificationSettings["apprise"], m: NotifyMessage, policy: TargetPolicy) {
  if (!cfg.apiUrl) throw new Error("Apprise API URL is not set");
  if (!cfg.urls) throw new Error("No Apprise URLs set");
  const urls = appriseUrls(cfg.urls);
  if (!policy.allowPrivate) {
    for (const u of urls) {
      const problem = appriseUrlProblem(u);
      if (problem) throw new Error(`Apprise: ${problem}`);
    }
  }
  await post(
    `${cfg.apiUrl.replace(/\/+$/, "")}/notify/`,
    {
      json: true,
      body: JSON.stringify({
        urls: urls.join(","),
        title: m.title,
        body: m.url ? `${m.body}\n${m.url}` : m.body,
        type: failed(m) ? "failure" : m.event === "test" ? "info" : "success",
      }),
    },
    policy,
  );
}
