import { SECRET_MASK, notificationSettingsSchema, type Job, type NotificationChannel, type NotificationSettings } from "@specharvest/shared";
import { env } from "../config.ts";
import * as db from "../db/sqlite.ts";
import { getUser } from "../auth/users.ts";
import { httpError } from "../lib/http-error.ts";
import { createLogger, errorMessage } from "../lib/logger.ts";
import { assertPublicUrl, notifyPolicy, type TargetPolicy } from "../lib/net-guard.ts";
import { decryptSecret, encryptSecret, isEncryptedSecret } from "../lib/secrets.ts";
import { appriseUrlProblem, appriseUrls, sendApprise, sendDiscord, sendNtfy, sendTelegram, sendWebhook, type NotifyEvent, type NotifyMessage } from "./channels.ts";
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

/** Binds each stored secret to its user and field, so a value copied elsewhere in the table won't decrypt. */
const secretAad = (userId: number, channel: string, field: string) => `notify:${userId}:${channel}.${field}`;

/** The user's channels with secrets decrypted. Values saved before encryption existed are read as they are. */
export function getNotificationSettings(userId: number): NotificationSettings {
  const stored = db.getSetting<Record<string, Record<string, unknown>>>(settingsKey(userId)) ?? {};
  for (const [ch, field] of SECRETS) {
    const value = stored[ch]?.[field];
    if (typeof value !== "string" || !isEncryptedSecret(value)) continue;
    try {
      stored[ch][field] = decryptSecret(value, secretAad(userId, ch, field));
    } catch (err) {
      log.warn(`Notification secret ${ch}.${field} of user ${userId} can't be decrypted (was ENCRYPTION_KEY changed?) — enter it again`, errorMessage(err));
      stored[ch][field] = "";
    }
  }
  return notificationSettingsSchema.parse(stored);
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

/** URL fields of each channel, checked on save (label for error messages). */
const URL_FIELDS: Array<[keyof NotificationSettings, string, string]> = [
  ["ntfy", "server", "ntfy server"],
  ["discord", "webhookUrl", "Discord/Slack webhook URL"],
  ["webhook", "url", "Webhook URL"],
  ["apprise", "apiUrl", "Apprise API URL"],
];

/**
 * Enabled channels may only point where the user may send (lib/net-guard.ts notifyPolicy): http(s), and for
 * non-admins a public host or one of OUTBOUND_ALLOWED_HOSTS. Sending checks again, at connect time.
 */
async function assertTargets(s: NotificationSettings, policy: TargetPolicy) {
  const channels = s as unknown as Record<string, Record<string, unknown>>;
  for (const [ch, field, label] of URL_FIELDS) {
    const value = channels[ch][field];
    if (!channels[ch].enabled || typeof value !== "string" || !value) continue;
    try {
      await assertPublicUrl(value, policy);
    } catch (err) {
      throw httpError(400, `${label}: ${errorMessage(err)}`);
    }
  }
  if (s.apprise.enabled && !policy.allowPrivate) {
    for (const u of appriseUrls(s.apprise.urls)) {
      const problem = appriseUrlProblem(u);
      if (problem) throw httpError(400, `Apprise URL: ${problem}`);
    }
  }
}

/** Validates and stores the user's channels; secrets are encrypted at rest (lib/secrets.ts). */
export async function saveNotificationSettings(user: { id: number; role: string }, incoming: unknown): Promise<NotificationSettings> {
  const next = mergeSettings(getNotificationSettings(user.id), incoming);
  await assertTargets(next, notifyPolicy(user));
  const stored = structuredClone(next) as unknown as Record<string, Record<string, unknown>>;
  for (const [ch, field] of SECRETS) {
    const value = stored[ch][field];
    if (typeof value === "string" && value) stored[ch][field] = encryptSecret(value, secretAad(user.id, ch, field));
  }
  db.setSetting(settingsKey(user.id), stored);
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

const senders: Record<NotificationChannel, (s: NotificationSettings, m: NotifyMessage, userId: number, policy: TargetPolicy) => Promise<unknown>> = {
  ntfy: (s, m, _u, policy) => sendNtfy(s.ntfy, m, policy),
  telegram: (s, m, _u, policy) => sendTelegram(s.telegram, m, policy),
  discord: (s, m, _u, policy) => sendDiscord(s.discord, m, policy),
  webhook: (s, m, _u, policy) => sendWebhook(s.webhook, m, policy),
  apprise: (s, m, _u, policy) => sendApprise(s.apprise, m, policy),
  push: (_s, m, userId) => sendPush(m, userId),
};

/** Channels to use for real events: enabled ones, plus push when any browser subscribed. */
export function enabledChannels(s: NotificationSettings, pushSubscribers: number): NotificationChannel[] {
  const out: NotificationChannel[] = [];
  for (const ch of ["ntfy", "telegram", "discord", "webhook", "apprise"] as const) if (s[ch].enabled) out.push(ch);
  if (pushSubscribers > 0) out.push("push");
  return out;
}

/**
 * Sends to every channel; one failing channel never blocks the others. Returns per-channel errors.
 * Where it may send depends on who the channels belong to (admins may reach private addresses).
 */
export async function dispatch(s: NotificationSettings, m: NotifyMessage, channels: NotificationChannel[], userId: number) {
  const policy = notifyPolicy(getUser(userId));
  const results = await Promise.allSettled(channels.map((ch) => senders[ch](s, m, userId, policy)));
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
