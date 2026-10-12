import { EXTENSION_DEFAULT_CONCURRENCY, EXTENSION_MAX_CONCURRENCY } from "@specharvest/shared";

/** Where crawl tabs open. */
export type TabMode = "minimized" | "background" | "group";

export interface Settings {
  /** SpecHarvest origin, e.g. https://specharvest.example.com */
  serverUrl: string;
  /** Extension token (or API key); empty when not connected. */
  token: string;
  /** Account the token belongs to (shown in the UI). */
  email: string;
  deviceName: string;
  tabMode: TabMode;
  concurrency: number;
  /** Move a crawl to a visible background window when a site loads items on scroll (hidden pages don't scroll). */
  autoVisible: boolean;
  /** Sites (siteOf host) that needed a visible window: their crawls open there right away. */
  visibleSites: string[];
  /** Sites checked once and found not to need it (their crawls stay where tabMode puts them). */
  hiddenOkSites: string[];
}

const DEFAULTS: Settings = {
  serverUrl: "",
  token: "",
  email: "",
  deviceName: "",
  tabMode: "minimized",
  concurrency: EXTENSION_DEFAULT_CONCURRENCY,
  autoVisible: true,
  visibleSites: [],
  hiddenOkSites: [],
};

export async function getSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get<Partial<Settings>>(Object.keys(DEFAULTS) as Array<keyof Settings>);
  const s = { ...DEFAULTS, ...stored };
  s.concurrency = Math.min(EXTENSION_MAX_CONCURRENCY, Math.max(1, Math.round(s.concurrency) || EXTENSION_DEFAULT_CONCURRENCY));
  return s;
}

export async function saveSettings(patch: Partial<Settings>) {
  await chrome.storage.local.set(patch);
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
