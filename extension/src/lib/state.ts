/**
 * Live state the background worker shares with the popup and options page, kept in storage.session (gone when
 * Chrome closes; the pages subscribe with chrome.storage.onChanged).
 */

export type ConnectionStatus = "unconfigured" | "connecting" | "online" | "offline" | "error";

export interface PendingPermission {
  /** e.g. https://olx.ba */
  origin: string;
  at: number;
}

export interface LiveState {
  status: ConnectionStatus;
  /** Why it's offline / in error, for the UI. */
  message: string;
  /** Tabs the server is using right now. */
  openTabs: number;
  /** Sites a crawl waits to be allowed on. */
  pendingPermissions: PendingPermission[];
  /** Approve-in-the-web-app pairing in progress: the code the web page shows too. */
  pairingCode: string | null;
}

const DEFAULT_STATE: LiveState = { status: "unconfigured", message: "", openTabs: 0, pendingPermissions: [], pairingCode: null };

export async function getState(): Promise<LiveState> {
  const { live } = (await chrome.storage.session.get("live")) as { live?: LiveState };
  return { ...DEFAULT_STATE, ...live };
}

/** Serialized so concurrent updates from different events don't overwrite each other. */
let chain: Promise<unknown> = Promise.resolve();

export function updateState(patch: Partial<LiveState> | ((s: LiveState) => Partial<LiveState>)): Promise<LiveState> {
  const next = chain.then(async () => {
    const current = await getState();
    const updated = { ...current, ...(typeof patch === "function" ? patch(current) : patch) };
    await chrome.storage.session.set({ live: updated });
    return updated;
  });
  chain = next.catch(() => {});
  return next;
}

export function onStateChange(fn: (s: LiveState) => void): () => void {
  const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area === "session" && changes.live) fn({ ...DEFAULT_STATE, ...(changes.live.newValue as LiveState) });
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}

/** Messages from the popup / options page to the background worker. */
export type BackgroundRequest =
  | { type: "reconnect" }
  | { type: "disconnect" }
  | { type: "startPairing"; serverUrl: string; deviceName: string }
  | { type: "cancelPairing" }
  | { type: "settingsChanged" };
