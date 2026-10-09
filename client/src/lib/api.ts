import type {
  AdminSettings,
  ApiKeyCreated,
  ApiKeySummary,
  AuthStatus,
  Collection,
  CollectionGroup,
  CollectionProducts,
  CrawlRequest,
  EnrichRequest,
  GroupInput,
  GroupingMode,
  Item,
  ItemDetail,
  Job,
  JobEvent,
  NotificationChannel,
  NotificationSettings,
  ProviderCredits,
  RecentSearch,
  SearchRequest,
  SearchResponse,
  SpecKey,
  UsageSummary,
  UserCreated,
  UserRole,
  UserSummary,
} from "@specharvest/shared";
import { isActiveJob } from "@specharvest/shared";
import { useCallback, useEffect, useRef, useState } from "react";

export interface AppConfig {
  proxyConfigured: boolean;
  webSearchEnabled: boolean;
  llmConfigured: boolean;
  defaults: { maxPages: number; maxItems: number };
  models: { main: string; extraction: string; web: string };
}

/** Fired when the session is gone (expired, revoked, user disabled) — the app drops back to the login screen. */
export const UNAUTHORIZED_EVENT = "specharvest:unauthorized";

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  // A 401 from the credential endpoints is just a wrong password, not a lost session.
  if (res.status === 401 && !url.startsWith("/api/auth/")) window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
  if (!res.ok) throw new Error(data?.error ?? `${res.status} ${res.statusText}`);
  return data as T;
}

export const api = {
  config: () => request<AppConfig>("GET", "/api/config"),
  collections: () => request<Collection[]>("GET", "/api/collections"),
  keys: (collectionId: number | null) => request<SpecKey[]>("GET", collectionId ? `/api/collections/${collectionId}/keys` : "/api/keys"),
  renameCollection: (id: number, name: string) => request<Collection>("PATCH", `/api/collections/${id}`, { name }),
  shareCollection: (id: number, isShared: boolean) => request<Collection>("PATCH", `/api/collections/${id}`, { isShared }),
  setCollectionGrouping: (id: number, grouping: GroupingMode) => request<Collection>("PATCH", `/api/collections/${id}`, { grouping }),
  deleteCollection: (id: number) => request<{ ok: true }>("DELETE", `/api/collections/${id}`),
  /** Same-origin link — the session cookie authenticates the download. */
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
  enrich: (body: EnrichRequest) => request<{ job: Job | null; note?: string }>("POST", "/api/enrich", body),
  jobs: () => request<Job[]>("GET", "/api/jobs"),
  stopJob: (id: number) => request<Job>("POST", `/api/jobs/${id}/stop`),
  resumeJob: (id: number) => request<Job>("POST", `/api/jobs/${id}/resume`),
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
  login: (email: string, password: string) => request<UserSummary>("POST", "/api/auth/login", { email, password }),
  signup: (email: string, password: string) => request<UserSummary>("POST", "/api/auth/signup", { email, password }),
  logout: () => request<null>("POST", "/api/auth/logout"),
  updateAccount: (body: { currentPassword: string; email?: string; newPassword?: string }) => request<UserSummary>("PATCH", "/api/auth/me", body),
  apiKeys: () => request<ApiKeySummary[]>("GET", "/api/api-keys"),
  createApiKey: (label: string) => request<ApiKeyCreated>("POST", "/api/api-keys", { label }),
  revokeApiKey: (id: number) => request<{ ok: true }>("DELETE", `/api/api-keys/${id}`),
  // Admin
  users: () => request<UserSummary[]>("GET", "/api/users"),
  createUser: (email: string, role: UserRole) => request<UserCreated>("POST", "/api/users", { email, role }),
  setUserDisabled: (id: number, disabled: boolean) => request<UserSummary>("PATCH", `/api/users/${id}`, { disabled }),
  adminSettings: () => request<AdminSettings>("GET", "/api/settings/admin"),
  saveAdminSettings: (body: AdminSettings) => request<AdminSettings>("PUT", "/api/settings/admin", body),
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

/** USD with enough precision for sub-cent LLM calls: $0, $0.0042, $1.24. */
export function formatUsd(n: number): string {
  if (!n) return "$0";
  if (n < 0.0001) return "<$0.0001";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
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
    const es = new EventSource(`/api/jobs/${jobId}/events`);
    // A resumed job's replayed history contains its earlier stopped snapshot — close only if nothing newer follows.
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    const onEvent = (e: MessageEvent) => {
      if (idRef.current !== jobId) return;
      const ev = JSON.parse(e.data) as JobEvent;
      if (ev.type === "job") {
        clearTimeout(closeTimer);
        if (!isActiveJob(ev.job)) closeTimer = setTimeout(() => es.close(), 1500);
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
    for (const t of ["job", "log", "item", "queue"]) es.addEventListener(t, onEvent as EventListener);
    return () => {
      clearTimeout(closeTimer);
      es.close();
    };
  }, [jobId, nonce]);

  return state;
}


export interface JobsFeed {
  /** Latest snapshot of every job seen on the feed (active and recently finished). */
  jobs: Map<number, Job>;
  active: Job[];
}

/**
 * All jobs over one SSE connection. `onFinish` fires when a job seen running stops being active (done/failed/stopped) —
 * including jobs that finished while the connection was down (reconciled on reconnect).
 */
export function useJobsFeed(onFinish: (job: Job) => void): JobsFeed {
  const [jobs, setJobs] = useState<Map<number, Job>>(new Map());
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
    const es = new EventSource("/api/jobs/events");
    es.addEventListener("job", (e) => apply([(JSON.parse((e as MessageEvent).data) as { job: Job }).job]));
    es.addEventListener("jobs", (e) => {
      const snapshot = (JSON.parse((e as MessageEvent).data) as { jobs: Job[] }).jobs;
      const stillActive = new Set(snapshot.map((j) => j.id));
      const vanished = [...jobsRef.current.values()].filter((j) => isActiveJob(j) && !stillActive.has(j.id));
      apply(snapshot);
      // Jobs we saw running that finished while disconnected: fetch their final state.
      if (vanished.length) api.jobs().then((all) => apply(all.filter((j) => vanished.some((v) => v.id === j.id))), () => {});
    });
    return () => es.close();
  }, [apply]);

  const active = [...jobs.values()].filter(isActiveJob).sort((a, b) => a.id - b.id);
  return { jobs, active };
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
  const opts: NotificationOptions = { body, tag, icon: "/favicon.svg", data: { url } };
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
