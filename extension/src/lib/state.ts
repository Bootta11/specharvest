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

/** One server's connection, for the UI. */
export interface ServerStatus {
  status: ConnectionStatus;
  /** Why it's offline / in error. */
  message: string;
}

export interface LiveState {
  /** By ServerEntry id. A server missing here hasn't connected since Chrome started. */
  servers: Record<string, ServerStatus>;
  /** Tabs the servers are using right now (all of them). */
  openTabs: number;
  /** Sites a crawl waits to be allowed on. */
  pendingPermissions: PendingPermission[];
  /** Approve-in-the-web-app pairing in progress: the server, the code the web page shows too, and how it's going. */
  pairing: { serverUrl: string; code: string | null; message: string } | null;
}

const DEFAULT_STATE: LiveState = { servers: {}, openTabs: 0, pendingPermissions: [], pairing: null };
const OFFLINE: ServerStatus = { status: "offline", message: "" };

export const serverStatus = (state: LiveState, id: string): ServerStatus => state.servers[id] ?? OFFLINE;

/** One server's status changed. */
export const setServerStatus = (id: string, status: ConnectionStatus, message = "") =>
  updateState((s) => ({ servers: { ...s.servers, [id]: { status, message } } }));

export const forgetServerStatus = (id: string) =>
  updateState((s) => {
    const { [id]: _, ...rest } = s.servers;
    return { servers: rest };
  });

/** The popup's header dot over all paired servers: online when all are, "connecting" while some are missing. */
export function overallStatus(state: LiveState, serverIds: string[]): { status: ConnectionStatus; label?: string } {
  if (!serverIds.length) return { status: "unconfigured" };
  const online = serverIds.filter((id) => serverStatus(state, id).status === "online").length;
  if (online === serverIds.length) return { status: "online" };
  if (serverIds.length === 1) return { status: serverStatus(state, serverIds[0]).status };
  return online ? { status: "connecting", label: `${online} of ${serverIds.length} connected` } : { status: "offline" };
}

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
  | { type: "reconnect"; serverId: string }
  | { type: "removeServer"; serverId: string }
  | { type: "startPairing"; serverUrl: string; deviceName: string }
  | { type: "cancelPairing" }
  | { type: "settingsChanged" };
