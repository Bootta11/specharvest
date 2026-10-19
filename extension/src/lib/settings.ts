import { EXTENSION_DEFAULT_CONCURRENCY, EXTENSION_MAX_CONCURRENCY } from "@specharvest/shared";

/** Where crawl tabs open. */
export type TabMode = "minimized" | "background" | "group";

/** One SpecHarvest server this browser is paired with. */
export interface ServerEntry {
  /** Stable local id (the server never sees it). */
  id: string;
  /** SpecHarvest origin, e.g. https://specharvest.example.com — one entry per origin. */
  serverUrl: string;
  /** Extension token (or API key); empty when signed out. */
  token: string;
  /** Account the token belongs to (shown in the UI). */
  email: string;
  deviceName: string;
  /** This server's tabs at once; null = an automatic share of `concurrency`. */
  tabLimit: number | null;
}

export interface Settings {
  servers: ServerEntry[];
  /** Where the popup's "Crawl this listing" / "Add this item" go. */
  popupServerId: string;
  tabMode: TabMode;
  /** Tabs at once for the whole browser, shared between the servers (see tabShares). */
  concurrency: number;
  /** Move a crawl to a visible background window when a site loads items on scroll (hidden pages don't scroll). */
  autoVisible: boolean;
  /** Sites (siteOf host) that needed a visible window: their crawls open there right away. */
  visibleSites: string[];
  /** Sites checked once and found not to need it (their crawls stay where tabMode puts them). */
  hiddenOkSites: string[];
}

const DEFAULTS: Settings = {
  servers: [],
  popupServerId: "",
  tabMode: "minimized",
  concurrency: EXTENSION_DEFAULT_CONCURRENCY,
  autoVisible: true,
  visibleSites: [],
  hiddenOkSites: [],
};

/** Single-server settings from before several servers were supported. */
const LEGACY_KEYS = ["serverUrl", "token", "email", "deviceName"] as const;

export const newServerId = () => crypto.randomUUID();

/** Once: the old single serverUrl/token become the first server, so an existing pairing keeps working. */
async function migrate() {
  type Stored = Partial<Record<(typeof LEGACY_KEYS)[number], string>> & { servers?: ServerEntry[] };
  const old = await chrome.storage.local.get<Stored>([...LEGACY_KEYS, "servers"]);
  if (!old.serverUrl || old.servers) {
    if (old.serverUrl !== undefined) await chrome.storage.local.remove([...LEGACY_KEYS]);
    return;
  }
  // A fixed id: the background and an open options page may both migrate at once, and must write the same entry.
  const server: ServerEntry = { id: "migrated", serverUrl: old.serverUrl, token: old.token ?? "", email: old.email ?? "", deviceName: old.deviceName ?? "", tabLimit: null };
  await chrome.storage.local.set({ servers: [server], popupServerId: server.id });
  await chrome.storage.local.remove([...LEGACY_KEYS]);
}

let migrated: Promise<void> | null = null;

export async function getSettings(): Promise<Settings> {
  await (migrated ??= migrate().catch(() => {}));
  const stored = await chrome.storage.local.get<Partial<Settings>>(Object.keys(DEFAULTS) as Array<keyof Settings>);
  const s = { ...DEFAULTS, ...stored };
  s.concurrency = Math.min(EXTENSION_MAX_CONCURRENCY, Math.max(1, Math.round(s.concurrency) || EXTENSION_DEFAULT_CONCURRENCY));
  if (!s.servers.some((x) => x.id === s.popupServerId)) s.popupServerId = s.servers[0]?.id ?? "";
  return s;
}

export async function saveSettings(patch: Partial<Settings>) {
  await chrome.storage.local.set(patch);
}

/** Serialized, so two servers updating their entries at once don't overwrite each other. */
let serversChain: Promise<unknown> = Promise.resolve();

/** Changes the server list (add, update, remove) from its current stored value. */
export function updateServers(fn: (servers: ServerEntry[]) => ServerEntry[]): Promise<ServerEntry[]> {
  const next = serversChain.then(async () => {
    const servers = fn((await getSettings()).servers);
    await chrome.storage.local.set({ servers });
    return servers;
  });
  serversChain = next.catch(() => {});
  return next;
}

export const patchServer = (id: string, patch: Partial<ServerEntry>) => updateServers((list) => list.map((x) => (x.id === id ? { ...x, ...patch } : x)));

export const findServer = async (id: string) => (await getSettings()).servers.find((x) => x.id === id) ?? null;

/**
 * Each server's tabs at once. A server with its own limit keeps it; what's left of the browser-wide limit is
 * split evenly between the other servers that are online (at least 1 each, the remainder to the first ones).
 * Offline servers get their would-be share too, so the options page can show it.
 */
export function tabShares(settings: Pick<Settings, "servers" | "concurrency">, onlineIds: Iterable<string>): Map<string, number> {
  const online = new Set(onlineIds);
  const shares = new Map<string, number>();
  const max = EXTENSION_MAX_CONCURRENCY;
  const fixed = settings.servers.filter((x) => x.tabLimit != null);
  for (const x of fixed) shares.set(x.id, Math.min(max, Math.max(1, x.tabLimit!)));
  const usedByFixed = fixed.filter((x) => online.has(x.id)).reduce((sum, x) => sum + shares.get(x.id)!, 0);
  const auto = settings.servers.filter((x) => x.tabLimit == null);
  const autoOnline = auto.filter((x) => online.has(x.id));
  const left = Math.max(0, settings.concurrency - usedByFixed);
  autoOnline.forEach((x, i) => shares.set(x.id, Math.max(1, Math.floor(left / autoOnline.length) + (i < left % autoOnline.length ? 1 : 0))));
  // Offline: what it would get if it came online now.
  const ifJoined = Math.max(1, Math.floor(left / (autoOnline.length + 1)));
  for (const x of auto) if (!online.has(x.id)) shares.set(x.id, ifJoined);
  return shares;
}

/**
 * The server's origin from what the user typed: https only, except localhost for development.
 * Returns null when it isn't usable.
 */
export function normalizeServerUrl(input: string): string | null {
  let u: URL;
  try {
    u = new URL(/^https?:\/\//i.test(input.trim()) ? input.trim() : `https://${input.trim()}`);
  } catch {
    return null;
  }
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
  if (u.protocol !== "https:" && !(local && u.protocol === "http:")) return null;
  return u.origin;
}

/** A readable name for this browser, e.g. "Chrome on macOS". */
export function defaultDeviceName(): string {
  const platform = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform || navigator.platform || "";
  const os = /mac/i.test(platform) ? "macOS" : /win/i.test(platform) ? "Windows" : /linux/i.test(platform) ? "Linux" : /cros/i.test(platform) ? "ChromeOS" : platform;
  return os ? `Chrome on ${os}` : "Chrome";
}
