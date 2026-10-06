import webpush from "web-push";
import { env } from "../config.ts";
import * as db from "../db/sqlite.ts";
import { createLogger, errorMessage } from "../lib/logger.ts";
import type { NotifyMessage } from "./channels.ts";

const log = createLogger("push");

let keys: { publicKey: string; privateKey: string } | null = null;

/** VAPID keys from env, else generated once and kept in the settings table. */
export function vapidKeys() {
  if (keys) return keys;
  if (env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY) {
    keys = { publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY };
  } else {
    keys = db.getSetting<{ publicKey: string; privateKey: string }>("vapid");
    if (!keys) {
      keys = webpush.generateVAPIDKeys();
      db.setSetting("vapid", keys);
      log.info("Generated Web Push VAPID keys");
    }
  }
  webpush.setVapidDetails(env.VAPID_SUBJECT, keys.publicKey, keys.privateKey);
  return keys;
}

/** Sends to every browser the user subscribed; drops subscriptions the push service says are gone. */
export async function sendPush(m: NotifyMessage, userId: number): Promise<number> {
  const subs = db.listPushSubs(userId);
  if (subs.length === 0) throw new Error("No browser of yours has enabled push notifications");
  vapidKeys();
  const payload = JSON.stringify({
    title: m.title,
    body: m.body,
    tag: m.job ? `job-${m.job.id}` : `test-${Date.now()}`,
    url: m.job ? `/?job=${m.job.id}` : "/",
  });
  let sent = 0;
  const errors: string[] = [];
  await Promise.all(
    subs.map(async (sub) => {
      try {
        await webpush.sendNotification(sub, payload, { TTL: 24 * 3600 });
        sent++;
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) db.deletePushSub(sub.endpoint);
        else errors.push(errorMessage(err));
      }
    }),
  );
  if (sent === 0 && errors.length) throw new Error(errors[0]);
  return sent;
}
