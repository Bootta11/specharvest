import webpush from "web-push";
import { env } from "../config.ts";
import * as db from "../db/sqlite.ts";
import { createLogger, errorMessage } from "../lib/logger.ts";
import { assertPublicUrl, guardedHttpsAgent, strictPolicy } from "../lib/net-guard.ts";
import { decryptSecret, encryptSecret, isEncryptedSecret } from "../lib/secrets.ts";
import type { NotifyMessage } from "./channels.ts";

const log = createLogger("push");

type VapidKeys = { publicKey: string; privateKey: string };
let keys: VapidKeys | null = null;

const VAPID_SETTING = "vapid";
const VAPID_AAD = "vapid";

/** Stores generated keys with the private one encrypted (lib/secrets.ts). */
function storeKeys(k: VapidKeys) {
  db.setSetting(VAPID_SETTING, { publicKey: k.publicKey, privateKey: encryptSecret(k.privateKey, VAPID_AAD) });
}

/** The stored keys; ones saved before encryption get encrypted now. Null when missing or undecryptable. */
function storedKeys(): VapidKeys | null {
  const stored = db.getSetting<VapidKeys>(VAPID_SETTING);
  if (!stored) return null;
  if (!isEncryptedSecret(stored.privateKey)) {
    storeKeys(stored);
    return stored;
  }
  try {
    return { publicKey: stored.publicKey, privateKey: decryptSecret(stored.privateKey, VAPID_AAD) };
  } catch (err) {
    log.warn("Stored Web Push keys can't be decrypted (was ENCRYPTION_KEY changed?) — generating new ones; browsers need to turn push on again", errorMessage(err));
    return null;
  }
}

/** VAPID keys from env, else generated once and kept in the settings table. */
export function vapidKeys() {
  if (keys) return keys;
  if (env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY) {
    keys = { publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY };
  } else {
    keys = storedKeys();
    if (!keys) {
      keys = webpush.generateVAPIDKeys();
      storeKeys(keys);
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
  // Endpoints come from browsers (i.e. users): real push services are public, nothing else is reached.
  const policy = strictPolicy();
  await Promise.all(
    subs.map(async (sub) => {
      try {
        await assertPublicUrl(sub.endpoint, policy);
        await webpush.sendNotification(sub, payload, { TTL: 24 * 3600, agent: guardedHttpsAgent(policy) });
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
