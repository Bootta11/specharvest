import { App as CapacitorApp } from "@capacitor/app";
import { CapacitorUpdater } from "@capgo/capacitor-updater";
import { z } from "zod";
import { BUNDLE_PUBLIC_KEY } from "./app-release.ts";
import { serverUrl } from "./platform.ts";

/**
 * Android app: live UI updates (docs/app-updates.md). The server's image carries the UI built from the same commit
 * (GET /api/app/bundle); when it differs from the one running, the app downloads it in the background and switches
 * to it the next time it's reopened. Only bundles signed with the release key are applied, so a custom or
 * compromised server can't put its own code in the app. A UI that needs newer native code than this APK has is
 * never applied; the APK banner (lib/apk-update.ts) asks for the app update instead.
 */

const CHECK_EVERY_MS = 30 * 60_000;

const manifestSchema = z.object({
  version: z.string().min(1),
  url: z.string().min(1),
  checksum: z.string().regex(/^[0-9a-f]{64}$/),
  minVersionCode: z.number().int().positive(),
  signature: z.string().nullable(),
});
type Manifest = z.infer<typeof manifestSchema>;

let lastCheck = 0;
let lastServer = "";

/** The versionCode the server's UI needs when this APK is older; null when it isn't. */
let neededVersionCode: number | null = null;
const listeners = new Set<() => void>();

export const appUpdateNeeded = () => neededVersionCode;

export function onAppUpdateNeeded(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

function setNeeded(versionCode: number | null) {
  if (neededVersionCode === versionCode) return;
  neededVersionCode = versionCode;
  listeners.forEach((l) => l());
}

/**
 * Call once the UI has rendered, on every screen (sign-in included): without notifyAppReady the plugin takes the
 * bundle for broken and rolls back to the previous one. Then checks now and whenever the app comes back.
 */
export async function initUpdates() {
  try {
    await CapacitorUpdater.notifyAppReady();
  } catch (err) {
    console.error("notifyAppReady failed:", err);
  }
  // Local builds ("dev") keep their own UI; without the public key nothing could be verified.
  if (__APP_SHA__ === "dev" || !BUNDLE_PUBLIC_KEY) return;
  void checkForUpdate();
  await CapacitorApp.addListener("appStateChange", ({ isActive }) => {
    if (isActive) void checkForUpdate();
  });
}

const base64Bytes = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

async function verified(m: Manifest & { signature: string }): Promise<boolean> {
  const der = base64Bytes(BUNDLE_PUBLIC_KEY.replace(/-----[^-]+-----/g, "").replace(/\s+/g, ""));
  const key = await crypto.subtle.importKey("spki", der, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  const message = new TextEncoder().encode(`${m.version}\n${m.checksum}\n${m.minVersionCode}`);
  return crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, base64Bytes(m.signature), message);
}

/** At most every 30 minutes, unless the app switched to another server since the last check. */
async function checkForUpdate() {
  const server = serverUrl();
  if (server === lastServer && Date.now() - lastCheck < CHECK_EVERY_MS) return;
  lastCheck = Date.now();
  lastServer = server;
  try {
    const res = await fetch(`${server}/api/app/bundle`, { cache: "no-store" });
    if (!res.ok) return; // 404: a dev server or an image from before live updates
    const parsed = manifestSchema.safeParse(await res.json());
    if (!parsed.success) return;
    const m = parsed.data;
    if (!m.signature || !(await verified({ ...m, signature: m.signature }))) {
      console.warn(`Ignoring the UI bundle from ${server}: not signed with the release key`);
      return;
    }

    const build = Number((await CapacitorApp.getInfo()).build);
    if (m.minVersionCode > build) return setNeeded(m.minVersionCode);
    setNeeded(null);

    const { bundle } = await CapacitorUpdater.current();
    const running = bundle.id === "builtin" ? __APP_SHA__ : bundle.version;
    if (m.version === running) return;
    // The server runs the same commit this APK was built from: go back to the UI inside the APK.
    if (m.version === __APP_SHA__) return void (await CapacitorUpdater.next({ id: "builtin" }));

    const { bundles } = await CapacitorUpdater.list();
    const ready = bundles.find((b) => b.version === m.version && (b.status === "success" || b.status === "pending"));
    const next =
      ready ?? (await CapacitorUpdater.download({ url: new URL(m.url, server).href, version: m.version, checksum: m.checksum }));
    // Applied when the app next goes to the background and comes back, or starts.
    await CapacitorUpdater.next({ id: next.id });
    // Older downloads are never used again.
    for (const b of bundles) if (b.id !== bundle.id && b.id !== next.id) await CapacitorUpdater.delete({ id: b.id }).catch(() => {});
  } catch (err) {
    console.error("UI update check failed:", err);
  }
}
