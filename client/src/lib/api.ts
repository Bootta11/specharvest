import type {
  AdminSettings,
  ApiKeyCreated,
  ApiKeySummary,
  AuthStatus,
  BrowserInput,
  BrowserPatch,
  BrowserStatus,
  BrowserTestResult,
  CapacityRun,
  BurstBuildStatus,
  BurstOptions,
  BurstSettings,
  BurstStatus,
  Collection,
  CollectionGroup,
  CollectionProducts,
  CrawlRequest,
  InspectResult,
  EnrichRequest,
  ExtensionDevice,
  ExtensionStatus,
  GroupInput,
  GroupingMode,
  Item,
  ItemDetail,
  Job,
  JobEvent,
  LlmModelChoices,
  LlmModelList,
  LlmSettingsResponse,
  LlmStatus,
  LlmTestResult,
  LlmTier,
  NotificationChannel,
  NotificationSettings,
  ProviderCredits,
  RecentSearch,
  Runner,
  SearchRequest,
  SearchResponse,
  SpecKey,
  UsageSummary,
  UserCreated,
  UserRole,
  UserSummary,
} from "@specharvest/shared";
import { isActiveJob, isHttpUrl } from "@specharvest/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { activeAccount, apiUrl, authHeaders, forgetAccount, isNative, saveAccount, serverUrl } from "./platform.ts";

export interface AppConfig {
  proxyConfigured: boolean;
  /** The signed-in user can run web lookups (own web-capable key or the server key). */
  webSearchEnabled: boolean;
  /** The signed-in user can crawl and parse searches (own key or the server key). */
  llmConfigured: boolean;
  defaults: { maxPages: number; maxItems: number };
  /** Most one crawl may ask for (lower for non-admins). */
  limits: { maxPages: number; maxItems: number };
  /** Which provider/model each tier runs on for this user, and why a tier can't run. */
  llm: LlmStatus;
  /** Chrome Web Store page of the extension, when the server knows it. */
  extensionStoreUrl: string | null;
}

/** Fired when the session is gone (expired, revoked, user disabled) — the app drops back to the login screen. */
export const UNAUTHORIZED_EVENT = "specharvest:unauthorized";

/** A failed API call: the server's message, its status and — for 429 — how many seconds to wait. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfter: number | null,
  ) {
    super(message);
  }
}

// ---------- Server restarts (an update) ----------

/** Since when requests or live streams can't reach the server (null = they can); shown by ReconnectingBanner. */
let reconnectingSince: number | null = null;
const reconnectListeners = new Set<() => void>();

function setReconnecting(on: boolean) {
  const next = on ? (reconnectingSince ?? Date.now()) : null;
  if (next === reconnectingSince) return;
  reconnectingSince = next;
  for (const fn of reconnectListeners) fn();
}

/** Seconds the server has been unreachable while requests retry or streams reconnect, ticking; null when it's fine. */
export function useServerReconnecting(): number | null {
  const [since, setSince] = useState(reconnectingSince);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const onChange = () => setSince(reconnectingSince);
    reconnectListeners.add(onChange);
    onChange();
    return () => void reconnectListeners.delete(onChange);
  }, []);
  useEffect(() => {
    if (since === null) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [since]);
  return since === null ? null : Math.max(0, Math.round((now - since) / 1000));
}

/**
 * How long a request keeps retrying while the server restarts: its shutdown (up to ~22 s of refusing new jobs) plus
 * the restart itself (~15–20 s on the live host).
 */
const RESTART_RETRY_MS = 45_000;
const backoff = (attempt: number) => Math.min(1000 * 2 ** attempt, 5000);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const parseBody = (text: string): unknown => {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return undefined;
  }
};

/**
 * The request did nothing because the server is restarting: its own 503 `{restarting: true}` while it shuts down, or
 * the proxy's plain-text 404/502/503/504 while no server is up (the API's own errors, e.g. an out-of-credit 503, are
 * JSON without that flag).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const restarting = (res: Response, data: any) =>
  (res.status === 503 && (data?.restarting === true || res.headers.has("retry-after"))) || ([404, 502, 503, 504].includes(res.status) && data === undefined);

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  // Only reads are retried after a network error: a write may already have reached the server.
  const idempotent = method === "GET" || method === "HEAD";
  let res: Response;
  // The API's JSON (as JSON.parse returns it), or undefined when the body isn't JSON.
  let data: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  const giveUpAt = Date.now() + RESTART_RETRY_MS;
  for (let attempt = 0; ; attempt++) {
    try {
      res = await fetch(apiUrl(url), {
        method,
        headers: { ...authHeaders(), ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      if (!idempotent || Date.now() + backoff(attempt) > giveUpAt) {
        setReconnecting(false);
        throw err;
      }
      setReconnecting(true);
      await sleep(backoff(attempt));
      continue;
    }
    data = parseBody(await res.text());
    const after = Number(res.headers.get("retry-after"));
    const wait = Number.isFinite(after) && after > 0 ? Math.min(after, 10) * 1000 : backoff(attempt);
    if (!restarting(res, data) || Date.now() + wait > giveUpAt) {
      setReconnecting(false);
      break;
    }
    setReconnecting(true);
    await sleep(wait);
  }
  // A 401 from the credential endpoints is just a wrong password, not a lost session.
  if (res.status === 401 && !url.startsWith("/api/auth/")) window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
  if (!res.ok) {
    const retryAfter = Number(res.headers.get("retry-after"));
    // Invalid input (400 from zod): say what's wrong, not just "Invalid request".
    const issue: string | undefined = data?.issues?.[0]?.message;
    const message = data?.error ? (issue ? `${data.error}: ${issue}` : data.error) : `${res.status} ${res.statusText}`;
    throw new ApiError(message, res.status, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null);
  }
  return data as T;
}

/** The web gets the user (cookie set by the server); the app also gets its bearer token, saved as an account. */
type SignInResponse = UserSummary | { user: UserSummary; token: string };

async function signedIn(res: Promise<SignInResponse>): Promise<UserSummary> {
  const data = await res;
  if (!("token" in data)) return data;
  await saveAccount(serverUrl(), data.token, data.user);
  return data.user;
}

/**
 * Downloads an export: a plain link on the web (the cookie authenticates it); in the app, fetched with the token
 * and handed to the share sheet (native/files.ts), since a WebView can't save a link's download.
 */
export async function downloadExport(path: string, fallbackName: string) {
  if (!isNative) {
    const a = document.createElement("a");
    a.href = path;
    a.download = "";
    a.click();
    return;
  }
  const res = await fetch(apiUrl(path), { headers: authHeaders() });
  if (!res.ok) throw new Error(`Export failed (${res.status})`);
  const name = /filename="([^"]+)"/.exec(res.headers.get("Content-Disposition") ?? "")?.[1] ?? fallbackName;
  const { shareTextFile } = await import("./native.ts");
  await shareTextFile(name, await res.text());
}

export const api = {
  config: () => request<AppConfig>("GET", "/api/config"),
  collections: () => request<Collection[]>("GET", "/api/collections"),
  keys: (collectionId: number | null) => request<SpecKey[]>("GET", collectionId ? `/api/collections/${collectionId}/keys` : "/api/keys"),
  renameCollection: (id: number, name: string) => request<Collection>("PATCH", `/api/collections/${id}`, { name }),
  shareCollection: (id: number, isShared: boolean) => request<Collection>("PATCH", `/api/collections/${id}`, { isShared }),
  setCollectionGrouping: (id: number, grouping: GroupingMode) => request<Collection>("PATCH", `/api/collections/${id}`, { grouping }),
  deleteCollection: (id: number) => request<{ ok: true }>("DELETE", `/api/collections/${id}`),
  /** Export paths for downloadExport() (cookie on the web, bearer token in the app). */
  exportCollectionUrl: (id: number) => `/api/collections/${id}/export`,
  exportAllCollectionsUrl: "/api/collections/export",
  /** A single-collection export returns that collection; an "Export all" file returns the list. */
  importCollection: (data: unknown) => request<Collection | Collection[]>("POST", "/api/collections/import", data),
  collectionProducts: (id: number) => request<CollectionProducts>("GET", `/api/collections/${id}/products`),
  /** Answer a possible match: `to` = same product as that candidate, null = different from all of them. */
  decideMatch: (id: number, identity: string, to: string | null) => request<{ ok: true }>("POST", `/api/collections/${id}/matches`, { identity, to }),
  /** "Not the same product": take a name out of its group. */
  splitProductName: (id: number, identity: string) => request<{ ok: true }>("POST", `/api/collections/${id}/split`, { identity }),
  item: (id: number) => request<ItemDetail>("GET", `/api/items/${id}`),
  crawl: (body: CrawlRequest) => request<Job>("POST", "/api/crawl", body),
  /** What a URL is before crawling it: listing, single item, or an unrelated page. */
  inspectUrl: (url: string, runner?: Runner) => request<InspectResult>("POST", "/api/crawl/inspect", { url, runner }),
  enrich: (body: EnrichRequest) => request<{ job: Job | null; note?: string }>("POST", "/api/enrich", body),
  jobs: () => request<Job[]>("GET", "/api/jobs"),
  stopJob: (id: number) => request<Job>("POST", `/api/jobs/${id}/stop`),
  resumeJob: (id: number, runner?: Runner) => request<Job>("POST", `/api/jobs/${id}/resume`, runner ? { runner } : {}),
  search: (body: SearchRequest) => request<SearchResponse>("POST", "/api/search", body),
  usage: (all = false) => request<UsageSummary>("GET", `/api/usage${all ? "?scope=all" : ""}`),
  credits: () => request<ProviderCredits>("GET", "/api/usage/credits"),
  notificationSettings: () => request<NotificationSettings>("GET", "/api/settings/notifications"),
  saveNotificationSettings: (body: NotificationSettings) => request<NotificationSettings>("PUT", "/api/settings/notifications", body),
  testNotification: (channel: NotificationChannel) => request<{ ok: boolean; error?: string }>("POST", "/api/notifications/test", { channel }),
  pushKey: () => request<{ publicKey: string }>("GET", "/api/push/key"),
  pushSubscribe: (sub: PushSubscriptionJSON) => request<{ ok: true }>("POST", "/api/push/subscribe", sub),
  pushUnsubscribe: (endpoint: string) => request<{ ok: true }>("DELETE", "/api/push/subscribe", { endpoint }),
  // Auth & account
  authStatus: () => request<AuthStatus>("GET", "/api/auth/status"),
  me: () => request<UserSummary>("GET", "/api/auth/me"),
  login: (email: string, password: string) => signedIn(request<SignInResponse>("POST", "/api/auth/login", { email, password })),
  signup: (email: string, password: string) => signedIn(request<SignInResponse>("POST", "/api/auth/signup", { email, password })),
  /** In the app, signs out of (and forgets) the active account only; other saved accounts stay signed in. */
  logout: async () => {
    const account = activeAccount();
    try {
      await request<null>("POST", "/api/auth/logout");
    } finally {
      if (account) await forgetAccount(account.id);
    }
  },
  /** Deletes the account and everything it owns; in the app, also forgets that saved account. */
  deleteAccount: async (currentPassword: string) => {
    const account = activeAccount();
    await request<null>("DELETE", "/api/auth/me", { currentPassword });
    if (account) await forgetAccount(account.id);
  },
  updateAccount: (body: { currentPassword: string; email?: string; newPassword?: string }) => request<UserSummary>("PATCH", "/api/auth/me", body),
  apiKeys: () => request<ApiKeySummary[]>("GET", "/api/api-keys"),
  createApiKey: (label: string) => request<ApiKeyCreated>("POST", "/api/api-keys", { label }),
  revokeApiKey: (id: number) => request<{ ok: true }>("DELETE", `/api/api-keys/${id}`),
  extensionStatus: () => request<ExtensionStatus>("GET", "/api/extension/status"),
  extensionDevices: () => request<ExtensionDevice[]>("GET", "/api/extension/devices"),
  createExtensionToken: (name: string) => request<{ token: string; device: ExtensionDevice }>("POST", "/api/extension/devices", { name }),
  revokeExtensionDevice: (id: number) => request<{ ok: true }>("DELETE", `/api/extension/devices/${id}`),
  approveExtension: (challenge: string, deviceName: string) => request<{ ok: true }>("POST", "/api/extension/pair/approve", { challenge, deviceName }),
  // Admin
  users: () => request<UserSummary[]>("GET", "/api/users"),
  createUser: (email: string, role: UserRole) => request<UserCreated>("POST", "/api/users", { email, role }),
  setUserDisabled: (id: number, disabled: boolean) => request<UserSummary>("PATCH", `/api/users/${id}`, { disabled }),
  adminSettings: () => request<AdminSettings>("GET", "/api/settings/admin"),
  saveAdminSettings: (body: Partial<Pick<AdminSettings, "signupEnabled" | "serverLlmAccess" | "serverLlmDailyLimitUsd">>) =>
    request<AdminSettings>("PUT", "/api/settings/admin", body),
  burstStatus: () => request<BurstStatus>("GET", "/api/admin/burst"),
  saveBurstSettings: (body: Partial<Record<keyof BurstSettings, BurstSettings[keyof BurstSettings] | null>>) => request<BurstStatus>("PUT", "/api/admin/burst", body),
  saveBurstAccount: (body: { token?: string | null; allowedIp?: string | null; region?: string | null; size?: string | null }) =>
    request<BurstStatus>("PUT", "/api/admin/burst/account", body),
  testBurst: (token?: string) => request<Record<string, { ok: boolean; error?: string }>>("POST", "/api/admin/burst/test", token ? { token } : {}),
  burstOptions: () => request<BurstOptions>("GET", "/api/admin/burst/options"),
  detectBurstIp: () => request<{ ip: string }>("POST", "/api/admin/burst/detect-ip"),
  rebuildBurstImage: () => request<BurstBuildStatus>("POST", "/api/admin/burst/image"),
  browsers: () => request<BrowserStatus[]>("GET", "/api/admin/browsers"),
  createBrowser: (body: BrowserInput) => request<BrowserStatus[]>("POST", "/api/admin/browsers", body),
  updateBrowser: (id: number, body: BrowserPatch) => request<BrowserStatus[]>("PUT", `/api/admin/browsers/${id}`, body),
  deleteBrowser: (id: number) => request<BrowserStatus[]>("DELETE", `/api/admin/browsers/${id}`),
  testBrowser: (body: { id?: number; url?: string; apiKey?: string; username?: string; password?: string }) =>
    request<BrowserTestResult>("POST", "/api/admin/browsers/test", body),
  capacityTest: () => request<{ run: CapacityRun | null }>("GET", "/api/admin/browsers/capacity"),
  startCapacityTest: (name: string) => request<{ run: CapacityRun }>("POST", "/api/admin/browsers/capacity", { name }),
  stopCapacityTest: () => request<{ run: CapacityRun | null }>("DELETE", "/api/admin/browsers/capacity"),
  // LLM provider (own API keys, model picks)
  llmSettings: () => request<LlmSettingsResponse>("GET", "/api/settings/llm"),
  saveLlmKey: (provider: string, apiKey: string, baseUrl?: string) => request<LlmSettingsResponse>("PUT", `/api/settings/llm/keys/${encodeURIComponent(provider)}`, { apiKey, baseUrl }),
  deleteLlmKey: (provider: string) => request<LlmSettingsResponse>("DELETE", `/api/settings/llm/keys/${encodeURIComponent(provider)}`),
  saveLlmModels: (choices: LlmModelChoices) => request<LlmSettingsResponse>("PUT", "/api/settings/llm/models", choices),
  llmModelOptions: (provider: string, tier: LlmTier) => request<LlmModelList>("GET", `/api/settings/llm/models/${encodeURIComponent(provider)}?tier=${tier}`),
  testLlm: (tier: LlmTier) => request<LlmTestResult>("POST", "/api/settings/llm/test", { tier }),
  recentSearches: (scope: SearchScope) => {
    const { collectionId, groupId } = scopeParams(scope);
    return request<RecentSearch[]>("GET", `/api/searches${collectionId ? `?collectionId=${collectionId}` : groupId ? `?groupId=${groupId}` : ""}`);
  },
  groups: () => request<CollectionGroup[]>("GET", "/api/groups"),
  createGroup: (body: GroupInput) => request<CollectionGroup>("POST", "/api/groups", body),
  updateGroup: (id: number, body: Partial<GroupInput>) => request<CollectionGroup>("PATCH", `/api/groups/${id}`, body),
  deleteGroup: (id: number) => request<{ ok: true }>("DELETE", `/api/groups/${id}`),
};

/** What Search covers: "all" collections, one collection "c:<id>" or a group "g:<id>". */
export type SearchScope = "all" | `c:${number}` | `g:${number}`;

export function parseScope(raw: string | null): SearchScope | null {
  if (raw === "all") return "all";
  const m = /^([cg]):(\d+)$/.exec(raw ?? "");
  return m ? (`${m[1]}:${Number(m[2])}` as SearchScope) : null;
}

/** Request fields for a scope — at most one of them is set. */
export function scopeParams(scope: SearchScope): { collectionId: number | null; groupId: number | null } {
  const id = Number(scope.slice(2)) || null;
  return { collectionId: scope.startsWith("c:") ? id : null, groupId: scope.startsWith("g:") ? id : null };
}

/** A scraped or looked-up link/image, only if it's an absolute http(s) URL (older rows may hold anything). */
export const safeUrl = (url: string | null | undefined): string | undefined => (isHttpUrl(url) ? url : undefined);

/** USD with enough precision for sub-cent LLM calls: $0, $0.0042, $1.24. */
export function formatUsd(n: number): string {
  if (!n) return "$0";
  if (n < 0.0001) return "<$0.0001";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

// ---------- Server-sent events ----------

/** Fired by the app when it returns to the foreground (native.ts): streams reconnect at once. */
export const RESUME_EVENT = "specharvest:resume";

type StreamListeners = Record<string, (data: string) => void>;

/**
 * EventSource reconnects by itself after a dropped connection, but gives up for good on a non-200 answer — which is
 * what the proxy sends while the server restarts for an update. Then open a new one, with backoff. A new EventSource
 * can't send Last-Event-ID, so the last id goes in the query and only newer events are replayed.
 */
function openWebEventStream(path: string, listeners: StreamListeners): () => void {
  let closed = false;
  let es: EventSource | null = null;
  let lastId: string | undefined;
  let delay = 1000;
  let retry: ReturnType<typeof setTimeout> | undefined;

  const open = () => {
    const url = lastId ? `${path}${path.includes("?") ? "&" : "?"}lastEventId=${encodeURIComponent(lastId)}` : path;
    const source = new EventSource(apiUrl(url));
    es = source;
    for (const [type, fn] of Object.entries(listeners)) {
      source.addEventListener(type, (e) => {
        const ev = e as MessageEvent;
        if (ev.lastEventId) lastId = ev.lastEventId;
        fn(ev.data);
      });
    }
    source.onopen = () => {
      delay = 1000;
      setReconnecting(false);
    };
    source.onerror = () => {
      if (closed || source.readyState !== EventSource.CLOSED) return;
      // The server answered but isn't up (it restarts in seconds): retry often.
      setReconnecting(true);
      retry = setTimeout(open, delay);
      delay = Math.min(delay * 2, 5_000);
    };
  };

  open();
  return () => {
    closed = true;
    clearTimeout(retry);
    es?.close();
  };
}

/**
 * Subscribes to an SSE endpoint. The web uses EventSource (cookie auth). The app can't add headers to an
 * EventSource, so it reads the stream with fetch + the bearer token, resending Last-Event-ID and reconnecting
 * with backoff — and right away when the app comes back to the foreground (Android drops idle connections).
 */
export function openEventStream(path: string, listeners: StreamListeners): () => void {
  if (!isNative) return openWebEventStream(path, listeners);

  let closed = false;
  let attempt: AbortController | null = null;
  let lastId: string | undefined;
  let delay = 1000;
  let wake: (() => void) | null = null;

  const dispatch = (block: string) => {
    let type = "message";
    const data: string[] = [];
    for (const line of block.split("\n")) {
      if (!line || line.startsWith(":")) continue;
      const i = line.indexOf(":");
      const field = i < 0 ? line : line.slice(0, i);
      const value = i < 0 ? "" : line.slice(i + 1).replace(/^ /, "");
      if (field === "event") type = value;
      else if (field === "data") data.push(value);
      else if (field === "id") lastId = value;
    }
    if (data.length) listeners[type]?.(data.join("\n"));
  };

  const run = async () => {
    while (!closed) {
      attempt = new AbortController();
      // A fetch that fails (offline) backs off to 30 s; an answer from a server that isn't up (a restart) to 5 s.
      let maxDelay = 30_000;
      try {
        const res = await fetch(apiUrl(path), {
          headers: { ...authHeaders(), Accept: "text/event-stream", ...(lastId ? { "Last-Event-ID": lastId } : {}) },
          signal: attempt.signal,
        });
        if (res.status === 401) {
          window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
          return;
        }
        if (!res.ok || !res.body) {
          maxDelay = 5_000;
          throw new Error(`stream ${res.status}`);
        }
        delay = 1000;
        setReconnecting(false);
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
        let buf = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf = (buf + value).replace(/\r\n?/g, "\n");
          for (let i = buf.indexOf("\n\n"); i >= 0; i = buf.indexOf("\n\n")) {
            dispatch(buf.slice(0, i));
            buf = buf.slice(i + 2);
          }
        }
      } catch {
        /* dropped, aborted or offline — retry below */
      }
      if (closed) return;
      setReconnecting(true);
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, delay);
        wake = () => (clearTimeout(t), resolve());
      });
      wake = null;
      delay = Math.min(delay * 2, maxDelay);
    }
  };

  const onResume = () => {
    delay = 1000;
    attempt?.abort();
    wake?.();
  };
  window.addEventListener(RESUME_EVENT, onResume);
  void run();
  return () => {
    closed = true;
    window.removeEventListener(RESUME_EVENT, onResume);
    attempt?.abort();
    wake?.();
  };
}

export interface JobStream {
  job: Job | null;
  logs: Array<{ message: string; level: "info" | "warn" | "error"; at: number }>;
  recentItems: Array<{ title: string; url: string }>;
  queue: { size: number; pending: number } | null;
}

/** Live job state over SSE (the server replays history to late subscribers). Bump `nonce` to reconnect (e.g. after a resume). */
export function useJobStream(jobId: number | null, nonce = 0): JobStream {
  const [state, setState] = useState<JobStream>({ job: null, logs: [], recentItems: [], queue: null });
  const idRef = useRef(jobId);
  idRef.current = jobId;

  useEffect(() => {
    setState({ job: null, logs: [], recentItems: [], queue: null });
    if (!jobId) return;
    let close = () => {};
    // A resumed job's replayed history contains its earlier stopped snapshot — close only if nothing newer follows.
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    const onEvent = (data: string) => {
      if (idRef.current !== jobId) return;
      const ev = JSON.parse(data) as JobEvent;
      if (ev.type === "job") {
        clearTimeout(closeTimer);
        if (!isActiveJob(ev.job)) closeTimer = setTimeout(() => close(), 1500);
      }
      setState((s) => {
        switch (ev.type) {
          case "job":
            return { ...s, job: ev.job };
          case "log":
            return { ...s, logs: [...s.logs.slice(-199), { message: ev.message, level: ev.level, at: Date.now() }] };
          case "item":
            return { ...s, recentItems: [{ title: ev.title, url: ev.url }, ...s.recentItems].slice(0, 8) };
          case "queue":
            return { ...s, queue: { size: ev.size, pending: ev.pending } };
          default:
            return s;
        }
      });
    };
    close = openEventStream(`/api/jobs/${jobId}/events`, { job: onEvent, log: onEvent, item: onEvent, queue: onEvent });
    return () => {
      clearTimeout(closeTimer);
      close();
    };
  }, [jobId, nonce]);

  return state;
}


export interface JobsFeed {
  /** Latest snapshot of every job seen on the feed (active and recently finished). */
  jobs: Map<number, Job>;
  active: Job[];
  /** The user's browser extension (null until the feed connected). */
  extension: ExtensionStatus | null;
}

/**
 * All jobs over one SSE connection. `onFinish` fires when a job seen running stops being active (done/failed/stopped) —
 * including jobs that finished while the connection was down (reconciled on reconnect).
 */
export function useJobsFeed(onFinish: (job: Job) => void): JobsFeed {
  const [jobs, setJobs] = useState<Map<number, Job>>(new Map());
  const [extension, setExtension] = useState<ExtensionStatus | null>(null);
  const finishRef = useRef(onFinish);
  finishRef.current = onFinish;
  const jobsRef = useRef(jobs);

  const apply = useCallback((updates: Job[]) => {
    const next = new Map(jobsRef.current);
    for (const j of updates) {
      const prev = next.get(j.id);
      next.set(j.id, j);
      if (prev && isActiveJob(prev) && !isActiveJob(j)) finishRef.current(j);
    }
    jobsRef.current = next;
    setJobs(next);
  }, []);

  useEffect(() => {
    return openEventStream("/api/jobs/events", {
      job: (data) => apply([(JSON.parse(data) as { job: Job }).job]),
      // Sent on every (re)connect — also when the app comes back to the foreground.
      jobs: (data) => {
        const snapshot = (JSON.parse(data) as { jobs: Job[] }).jobs;
        const stillActive = new Set(snapshot.map((j) => j.id));
        const vanished = [...jobsRef.current.values()].filter((j) => isActiveJob(j) && !stillActive.has(j.id));
        apply(snapshot);
        // Jobs we saw running that finished while disconnected: fetch their final state.
        if (vanished.length) api.jobs().then((all) => apply(all.filter((j) => vanished.some((v) => v.id === j.id))), () => {});
      },
      extension: (data) => setExtension((JSON.parse(data) as { status: ExtensionStatus }).status),
    });
  }, [apply]);

  const active = [...jobs.values()].filter(isActiveJob).sort((a, b) => a.id - b.id);
  return { jobs, active, extension };
}

// ---------- Browser notifications ----------

const NOTIFY_KEY = "browserNotify";

export const browserNotifySupported = () => typeof window !== "undefined" && "Notification" in window;
export const pushSupported = () => "serviceWorker" in navigator && "PushManager" in window && window.isSecureContext;
export const browserNotifyEnabled = () => browserNotifySupported() && Notification.permission === "granted" && storageGet(NOTIFY_KEY) === "1";
export const setBrowserNotify = (on: boolean) => storageSet(NOTIFY_KEY, on ? "1" : "0");

export function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!("serviceWorker" in navigator)) return Promise.resolve(null);
  return navigator.serviceWorker.register("/sw.js").catch(() => null);
}

/** Shows an OS notification. Same tag as the Web Push one, so the two replace each other instead of doubling. */
export async function showLocalNotification(title: string, body: string, tag: string, url: string) {
  if (!browserNotifyEnabled()) return;
  const reg = await registerServiceWorker();
  const opts: NotificationOptions = { body, tag, icon: "/icon-192.png", data: { url } };
  if (reg) return reg.showNotification(title, opts);
  const n = new Notification(title, opts);
  n.onclick = () => {
    window.focus();
    location.href = url;
  };
}

export async function currentPushSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null;
  const reg = await registerServiceWorker();
  return reg ? reg.pushManager.getSubscription() : null;
}

function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padded = (base64 + "=".repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(padded);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export async function enablePush(): Promise<void> {
  if (!pushSupported()) throw new Error("Push needs HTTPS (or localhost) and a supporting browser");
  if ((await Notification.requestPermission()) !== "granted") throw new Error("Notification permission was denied");
  const reg = await registerServiceWorker();
  if (!reg) throw new Error("Service worker could not be registered");
  await navigator.serviceWorker.ready;
  const { publicKey } = await api.pushKey();
  const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) }));
  await api.pushSubscribe(sub.toJSON());
}

export async function disablePush(): Promise<void> {
  const sub = await currentPushSubscription();
  if (!sub) return;
  await api.pushUnsubscribe(sub.endpoint).catch(() => {});
  await sub.unsubscribe();
}

export function storageGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function storageSet(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode etc. */
  }
}

/** Typed searches start paid web lookups by themselves only when this device opted in (Settings → LLM provider). */
const AUTO_LOOKUP_STORAGE = "specharvest.autoLookup";
export const autoLookupEnabled = () => storageGet(AUTO_LOOKUP_STORAGE) === "1";
export const setAutoLookup = (on: boolean) => storageSet(AUTO_LOOKUP_STORAGE, on ? "1" : "0");
