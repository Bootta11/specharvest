import { SECRET_MASK, notificationSettingsSchema, type Job, type NotificationChannel, type NotificationSettings } from "@specharvest/shared";
import { env } from "../config.ts";
import * as db from "../db/sqlite.ts";
import { createLogger, errorMessage } from "../lib/logger.ts";
import { sendApprise, sendDiscord, sendNtfy, sendTelegram, sendWebhook, type NotifyEvent, type NotifyMessage } from "./channels.ts";
import { sendPush } from "./push.ts";

const log = createLogger("notify");
/** Each user has their own channels (pre-users settings are moved by db.assignOrphansTo). */
const settingsKey = (userId: number) => `notifications:${userId}`;

/** Secret fields per channel — masked in API responses. */
const SECRETS: Array<[keyof NotificationSettings, string]> = [
  ["ntfy", "token"],
  ["telegram", "botToken"],
  ["discord", "webhookUrl"],
  ["webhook", "url"],
  ["apprise", "urls"],
];

export function getNotificationSettings(userId: number): NotificationSettings {
  return notificationSettingsSchema.parse(db.getSetting(settingsKey(userId)) ?? {});
}

export function maskSettings(s: NotificationSettings): NotificationSettings {
  const out = structuredClone(s) as Record<string, Record<string, unknown>>;
  for (const [ch, field] of SECRETS) if (out[ch][field]) out[ch][field] = SECRET_MASK;
  return out as unknown as NotificationSettings;
}

/** Fields still holding the mask keep their stored value. */
export function mergeSettings(stored: NotificationSettings, incoming: unknown): NotificationSettings {
  const next = notificationSettingsSchema.parse(incoming) as unknown as Record<string, Record<string, unknown>>;
  const prev = stored as unknown as Record<string, Record<string, unknown>>;
  for (const [ch, field] of SECRETS) if (next[ch][field] === SECRET_MASK) next[ch][field] = prev[ch][field];
  return next as unknown as NotificationSettings;
}

export function saveNotificationSettings(userId: number, incoming: unknown): NotificationSettings {
  const next = mergeSettings(getNotificationSettings(userId), incoming);
  db.setSetting(settingsKey(userId), next);
  return next;
}

function formatUsd(n: number): string {
  if (!n) return "$0";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

export function jobEvent(job: Job): NotifyEvent | null {
  if (job.status !== "done" && job.status !== "failed") return null;
  if (job.kind === "crawl") return job.status === "done" ? "crawlDone" : "crawlFailed";
  return job.status === "done" ? "enrichDone" : "enrichFailed";
}

export function buildMessage(job: Job, collection: string | null, publicUrl = env.PUBLIC_URL): NotifyMessage {
  const event = jobEvent(job)!;
  const what = job.kind === "crawl" ? "Crawl" : "Web lookup";
  const outcome = job.status === "done" ? "done" : "failed";
  const title = `${what} ${outcome}${collection ? ` · ${collection}` : ""}`;
  const detail = job.status === "failed" ? (job.error ?? job.message ?? "Unknown error") : (job.message ?? "Finished");
  const secs = job.finishedAt ? Math.max(1, Math.round((job.finishedAt - job.startedAt) / 1000)) : null;
  const took = secs === null ? null : secs < 60 ? `${secs} s` : `${Math.round(secs / 60)} min`;
  const body = [detail, [took, job.llmCost ? `${formatUsd(job.llmCost)} LLM` : null].filter(Boolean).join(" · ")]
    .filter(Boolean)
    .join("\n");
  return { event, title, body, url: publicUrl ? `${publicUrl}/?job=${job.id}` : null, job, collection };
}

function wants(s: NotificationSettings, event: NotifyEvent): boolean {
  switch (event) {
    case "crawlDone":
      return s.events.crawlDone;
    case "crawlFailed":
      return s.events.crawlFailed;
    case "enrichDone":
      return s.events.enrichDone;
    case "enrichFailed":
      return false;
    case "test":
      return true;
  }
}

const senders: Record<NotificationChannel, (s: NotificationSettings, m: NotifyMessage, userId: number) => Promise<unknown>> = {
  ntfy: (s, m) => sendNtfy(s.ntfy, m),
  telegram: (s, m) => sendTelegram(s.telegram, m),
  discord: (s, m) => sendDiscord(s.discord, m),
  webhook: (s, m) => sendWebhook(s.webhook, m),
  apprise: (s, m) => sendApprise(s.apprise, m),
  push: (_s, m, userId) => sendPush(m, userId),
};

/** Channels to use for real events: enabled ones, plus push when any browser subscribed. */
export function enabledChannels(s: NotificationSettings, pushSubscribers: number): NotificationChannel[] {
  const out: NotificationChannel[] = [];
  for (const ch of ["ntfy", "telegram", "discord", "webhook", "apprise"] as const) if (s[ch].enabled) out.push(ch);
  if (pushSubscribers > 0) out.push("push");
  return out;
}

/** Sends to every channel; one failing channel never blocks the others. Returns per-channel errors. */
export async function dispatch(s: NotificationSettings, m: NotifyMessage, channels: NotificationChannel[], userId: number) {
  const results = await Promise.allSettled(channels.map((ch) => senders[ch](s, m, userId)));
  const errors: Partial<Record<NotificationChannel, string>> = {};
  results.forEach((r, i) => {
    if (r.status === "rejected") errors[channels[i]] = errorMessage(r.reason);
  });
  return errors;
}

/** Called when a job reaches done/failed; notifies the job's owner. Never throws. */
export async function notifyJobFinished(job: Job) {
  try {
    const event = jobEvent(job);
    if (!event || job.userId === null) return;
    const s = getNotificationSettings(job.userId);
    if (!wants(s, event)) return;
    const channels = enabledChannels(s, db.listPushSubs(job.userId).length);
    if (channels.length === 0) return;
    const collection = job.collectionId ? (db.getCollection(job.collectionId)?.name ?? null) : null;
    const errors = await dispatch(s, buildMessage(job, collection), channels, job.userId);
    for (const [ch, err] of Object.entries(errors)) log.warn(`${ch} notification for job ${job.id} failed: ${err}`);
  } catch (err) {
    log.error(`Notification for job ${job.id} failed`, errorMessage(err));
  }
}

/** Sends a test through one of the user's channels using their stored settings (even if the channel is disabled). */
export async function sendTest(userId: number, channel: NotificationChannel): Promise<{ ok: boolean; error?: string }> {
  const m: NotifyMessage = {
    event: "test",
    title: "SpecHarvest test notification",
    body: "Notifications are working.",
    url: env.PUBLIC_URL ? `${env.PUBLIC_URL}/` : null,
    job: null,
    collection: null,
  };
  const errors = await dispatch(getNotificationSettings(userId), m, [channel], userId);
  return errors[channel] ? { ok: false, error: errors[channel] } : { ok: true };
}
