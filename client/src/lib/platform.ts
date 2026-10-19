import { Capacitor } from "@capacitor/core";
import { Preferences } from "@capacitor/preferences";

/**
 * Web vs the Android app (Capacitor, see docs/mobile-app.md). The web build talks to its own origin with the
 * session cookie; the app talks to a chosen server with a bearer session token.
 */
export const isNative = Capacitor.isNativePlatform();

export const DEFAULT_SERVER = "https://specharvest.bootta.dev";

const SERVER_KEY = "serverUrl";
const ACCOUNTS_KEY = "accounts";
const ACTIVE_KEY = "activeAccount";
/** The account used before the last switch, to go back when the new one's server doesn't answer. */
const PREVIOUS_KEY = "previousAccount";
/** Before saved accounts, the app kept one token here; loadNativeSettings turns it into an account. */
const LEGACY_TOKEN_KEY = "sessionToken";

/**
 * A sign-in the app remembers (like Gmail's accounts): one per server + user, so switching servers or
 * accounts never signs you out. `token` is null once the server rejected it — the account stays listed as
 * signed out, and picking it pre-fills the sign-in form.
 */
export interface SavedAccount {
  /** `${server}#${userId}`; `${server}#` for a sign-in carried over from an older build until /me fills it in. */
  id: string;
  server: string;
  token: string | null;
  email: string;
  role: string;
}

/**
 * The app's server and accounts live in native storage (Capacitor Preferences) rather than the WebView's
 * localStorage, which Android may clear under storage pressure and which would sign you out. Loaded once
 * into memory before the UI renders (loadNativeSettings), so reads stay synchronous.
 */
const cache = new Map<string, string>();

function read(key: string): string | null {
  return cache.get(key) ?? null;
}

function write(key: string, value: string | null): Promise<void> {
  if (value === null) {
    cache.delete(key);
    return Preferences.remove({ key });
  }
  cache.set(key, value);
  return Preferences.set({ key, value });
}

/** Call before rendering in the app. Also adopts values an older build kept in localStorage or as one token. */
export async function loadNativeSettings() {
  if (!isNative) return;
  for (const key of [SERVER_KEY, ACCOUNTS_KEY, ACTIVE_KEY, PREVIOUS_KEY, LEGACY_TOKEN_KEY]) {
    const { value } = await Preferences.get({ key });
    let v = value;
    if (v === null && key !== ACCOUNTS_KEY && key !== ACTIVE_KEY && key !== PREVIOUS_KEY) {
      try {
        v = localStorage.getItem(key);
        if (v !== null) await Preferences.set({ key, value: v });
      } catch {
        /* no localStorage */
      }
    }
    if (v !== null) cache.set(key, v);
  }
  const legacy = read(LEGACY_TOKEN_KEY);
  if (legacy !== null) {
    const server = read(SERVER_KEY) ?? DEFAULT_SERVER;
    const id = `${server}#`;
    if (!accounts().some((a) => a.token === legacy)) await writeAccounts([...accounts(), { id, server, token: legacy, email: "", role: "" }]);
    if (!read(ACTIVE_KEY)) await write(ACTIVE_KEY, id);
    await write(LEGACY_TOKEN_KEY, null);
  }
}

export function accounts(): SavedAccount[] {
  try {
    const list = JSON.parse(read(ACCOUNTS_KEY) ?? "[]") as unknown;
    return Array.isArray(list) ? (list as SavedAccount[]) : [];
  } catch {
    return [];
  }
}

const writeAccounts = (list: SavedAccount[]) => write(ACCOUNTS_KEY, list.length ? JSON.stringify(list) : null);

export function activeAccount(): SavedAccount | null {
  if (!isNative) return null;
  const id = read(ACTIVE_KEY);
  return (id && accounts().find((a) => a.id === id)) || null;
}

/** Makes an account the one the app uses (null: none — the sign-in screen, with the others kept). */
export async function setActiveAccount(id: string | null) {
  const prev = read(ACTIVE_KEY);
  if (prev && id && prev !== id) await write(PREVIOUS_KEY, prev);
  await write(ACTIVE_KEY, id);
  const account = activeAccount();
  if (account) await setServerUrl(account.server);
}

/** After signing in, or after /me on a carried-over sign-in: stores the account and makes it active. */
export async function saveAccount(server: string, token: string | null, user: { id: number; email: string; role: string }) {
  const id = `${server}#${user.id}`;
  const active = read(ACTIVE_KEY);
  // Replaces the same account, and the active carried-over one on this server, which turns out to be it.
  const prev = accounts().find((a) => a.id === id) ?? accounts().find((a) => a.id === `${server}#` && a.id === active);
  const account: SavedAccount = { id, server, token: token ?? prev?.token ?? null, email: user.email, role: user.role };
  const rest = accounts().filter((a) => a.id !== id && !(a.id === `${server}#` && a.id === active));
  await writeAccounts([...rest, account]);
  await setActiveAccount(id);
}

/** The server rejected this account's token: keep it listed, signed out. */
export async function markSignedOut(id: string) {
  await writeAccounts(accounts().map((a) => (a.id === id ? { ...a, token: null } : a)));
}

export async function forgetAccount(id: string) {
  await writeAccounts(accounts().filter((a) => a.id !== id));
  if (read(ACTIVE_KEY) === id) await write(ACTIVE_KEY, null);
  if (read(PREVIOUS_KEY) === id) await write(PREVIOUS_KEY, null);
}

/** The signed-in account used before the active one (null when there's none to go back to). */
export function previousAccount(): SavedAccount | null {
  if (!isNative) return null;
  const id = read(PREVIOUS_KEY);
  if (!id || id === read(ACTIVE_KEY)) return null;
  return accounts().find((a) => a.id === id && a.token) ?? null;
}

/** "" on the web (same origin); the active account's server in the app, else the one picked on the sign-in screen. */
export function serverUrl(): string {
  if (!isNative) return "";
  return activeAccount()?.server ?? read(SERVER_KEY) ?? DEFAULT_SERVER;
}

/** The server the sign-in screen uses (a new account). */
export function setServerUrl(url: string) {
  return write(SERVER_KEY, url === DEFAULT_SERVER ? null : url);
}

/** "https://host:port" from what someone typed ("host", "host/", "http://ip:3100"). */
export function normalizeServerUrl(raw: string): string {
  const s = raw.trim();
  const url = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
  return url.origin;
}

/** The active account's bearer session token (never used on the web, which has the httpOnly cookie). */
export const sessionToken = () => activeAccount()?.token ?? null;

export const apiUrl = (path: string) => `${serverUrl()}${path}`;

/** Headers every API call from the app carries. */
export function authHeaders(): Record<string, string> {
  if (!isNative) return {};
  const token = sessionToken();
  return { "X-SpecHarvest-Client": "app", ...(token ? { Authorization: `Bearer ${token}` } : {}) };
}
