import { Capacitor } from "@capacitor/core";
import { Preferences } from "@capacitor/preferences";

/**
 * Web vs the Android app (Capacitor, see docs/mobile-app.md). The web build talks to its own origin with the
 * session cookie; the app talks to a chosen server with a bearer session token.
 */
export const isNative = Capacitor.isNativePlatform();

export const DEFAULT_SERVER = "https://specharvest.bootta.dev";

const SERVER_KEY = "serverUrl";
const TOKEN_KEY = "sessionToken";

/**
 * The app's server and token live in native storage (Capacitor Preferences) rather than the WebView's
 * localStorage, which Android may clear under storage pressure and which would sign you out. Loaded once
 * into memory before the UI renders (loadNativeSettings), so reads stay synchronous.
 */
const cache = new Map<string, string>();

function read(key: string): string | null {
  return cache.get(key) ?? null;
}

function write(key: string, value: string | null) {
  if (value === null) {
    cache.delete(key);
    void Preferences.remove({ key });
  } else {
    cache.set(key, value);
    void Preferences.set({ key, value });
  }
}

/** Call before rendering in the app. Also adopts values an older build kept in localStorage. */
export async function loadNativeSettings() {
  if (!isNative) return;
  for (const key of [SERVER_KEY, TOKEN_KEY]) {
    const { value } = await Preferences.get({ key });
    let v = value;
    if (v === null) {
      try {
        v = localStorage.getItem(key);
        if (v !== null) await Preferences.set({ key, value: v });
      } catch {
        /* no localStorage */
      }
    }
    if (v !== null) cache.set(key, v);
  }
}

/** "" on the web (same origin); the chosen server in the app. */
export function serverUrl(): string {
  return isNative ? (read(SERVER_KEY) ?? DEFAULT_SERVER) : "";
}

export function setServerUrl(url: string) {
  write(SERVER_KEY, url === DEFAULT_SERVER ? null : url);
}

/** "https://host:port" from what someone typed ("host", "host/", "http://ip:3100"). */
export function normalizeServerUrl(raw: string): string {
  const s = raw.trim();
  const url = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
  return url.origin;
}

/** The app's bearer session token (never used on the web, which has the httpOnly cookie). */
export const sessionToken = () => (isNative ? read(TOKEN_KEY) : null);
export const setSessionToken = (token: string | null) => write(TOKEN_KEY, token);

export const apiUrl = (path: string) => `${serverUrl()}${path}`;

/** Headers every API call from the app carries. */
export function authHeaders(): Record<string, string> {
  if (!isNative) return {};
  const token = sessionToken();
  return { "X-SpecHarvest-Client": "app", ...(token ? { Authorization: `Bearer ${token}` } : {}) };
}
