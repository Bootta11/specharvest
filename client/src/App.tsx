import { useCallback, useEffect, useState } from "react";
import type { Collection, CollectionGroup, Job, UserSummary } from "@specharvest/shared";
import { api, formatUsd, parseScope, showLocalNotification, storageGet, storageSet, useJobsFeed, type AppConfig, type SearchScope } from "./lib/api.ts";
import { IngestView } from "./views/IngestView.tsx";
import { SearchView } from "./views/SearchView.tsx";
import { SpendMenu } from "./components/SpendMenu.tsx";
import { SettingsModal } from "./components/SettingsModal.tsx";
import { UserMenu } from "./components/UserMenu.tsx";
import { AccountModal } from "./components/AccountModal.tsx";
import { AdminModal } from "./components/AdminModal.tsx";
import { LoginView } from "./views/LoginView.tsx";
import { useAuth, type Auth } from "./lib/auth.ts";

type Tab = "search" | "ingest";

/** The remembered search scope (older builds stored a bare `collectionId`, 0 = all). */
function readScope(): SearchScope | null {
  const stored = parseScope(storageGet("scope"));
  if (stored) return stored;
  const legacy = storageGet("collectionId");
  if (legacy === null) return null;
  return Number(legacy) ? `c:${Number(legacy)}` : "all";
}

/** `/?job=<id>` (from a notification) opens that job on the Collections tab. */
function takeJobParam(): boolean {
  const id = Number(new URLSearchParams(location.search).get("job"));
  if (!id) return false;
  storageSet("crawlJobId", String(id));
  history.replaceState(null, "", location.pathname);
  return true;
}

export default function App() {
  const auth = useAuth();
  if (auth.user === undefined) return null;
  if (auth.user === null) return <LoginView auth={auth} />;
  // Remount on user switch so nothing from the previous account lingers.
  return <Workspace key={auth.user.id} user={auth.user} auth={auth} />;
}

function Workspace({ user, auth }: { user: UserSummary; auth: Auth }) {
  const [dialog, setDialog] = useState<"account" | "admin" | null>(null);
  const [tab, setTab] = useState<Tab>(() => (takeJobParam() || storageGet("tab") === "ingest" ? "ingest" : "search"));
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [groups, setGroups] = useState<CollectionGroup[] | null>(null);
  const [scope, setScope] = useState<SearchScope | null>(readScope);
  const [error, setError] = useState<string | null>(null);

  const refreshCollections = useCallback(async () => {
    try {
      // Group item counts and members follow the collections, so they're refreshed together.
      const [c, g] = await Promise.all([api.collections(), api.groups()]);
      setCollections(c);
      setGroups(g);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  const onJobFinished = useCallback(
    (job: Job) => {
      refreshCollections();
      // Stopping was the user's own action — no alert needed.
      if (job.status === "stopped") return;
      const what = job.kind === "crawl" ? "Crawl" : "Web lookup";
      const name = collections.find((c) => c.id === job.collectionId)?.name;
      const detail = job.status === "failed" ? (job.error ?? job.message ?? "Failed") : (job.message ?? "Finished");
      const body = job.llmCost ? `${detail}\n${formatUsd(job.llmCost)} LLM` : detail;
      showLocalNotification(`${what} ${job.status === "done" ? "done" : job.status}${name ? ` · ${name}` : ""}`, body, `job-${job.id}`, `/?job=${job.id}`);
    },
    [collections, refreshCollections],
  );
  const feed = useJobsFeed(onJobFinished);

  useEffect(() => {
    api.config().then(setConfig, (err) => setError((err as Error).message));
    refreshCollections();
  }, [refreshCollections]);

  // Default to the first collection; drop a remembered collection or group that no longer exists.
  useEffect(() => {
    if (collections.length === 0 || groups === null) return;
    const exists =
      scope === "all" ||
      (scope?.startsWith("c:") && collections.some((c) => `c:${c.id}` === scope)) ||
      (scope?.startsWith("g:") && groups.some((g) => `g:${g.id}` === scope));
    if (!exists) setScope(`c:${collections[0].id}`);
  }, [collections, groups, scope]);

  const selectTab = (t: Tab) => {
    setTab(t);
    storageSet("tab", t);
  };
  const selectScope = (s: SearchScope) => {
    setScope(s);
    storageSet("scope", s);
  };

  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-20 border-b border-stone-200 bg-white/85 backdrop-blur dark:border-stone-800 dark:bg-stone-950/85">
        <div className="mx-auto flex h-14 max-w-7xl items-center gap-2 px-4 sm:gap-3">
          <img src="/favicon.svg" alt="" className="size-7" />
          <span className="hidden font-semibold tracking-tight sm:inline">SpecHarvest</span>
          <div className="ml-auto flex items-center gap-1.5 sm:gap-2">
            {feed.active.length > 0 && (
              <button
                onClick={() => selectTab("ingest")}
                className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full bg-brand-50 px-2.5 py-1 text-xs font-medium tabular-nums text-brand-800 hover:bg-brand-100 dark:bg-brand-900/40 dark:text-brand-100"
                title={`${feed.active.length} running — show jobs`}
              >
                <span className="relative flex size-2">
                  <span className="absolute inline-flex size-full animate-ping rounded-full bg-brand-500 opacity-75" />
                  <span className="relative inline-flex size-2 rounded-full bg-brand-600" />
                </span>
                {feed.active.length}
                <span className="hidden sm:inline">running</span>
              </button>
            )}
            <SpendMenu isAdmin={user.role === "admin"} />
            <button
              onClick={() => setSettingsOpen(true)}
              className="grid size-8 place-items-center rounded-full text-stone-500 hover:bg-stone-100 hover:text-stone-900 dark:hover:bg-stone-800 dark:hover:text-stone-100"
              title="Notification settings"
              aria-label="Notification settings"
            >
              <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
                <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
              </svg>
            </button>
          </div>
          <nav className="flex rounded-lg bg-stone-100 p-1 text-sm dark:bg-stone-900" aria-label="Main">
            {(["search", "ingest"] as const).map((t) => (
              <button
                key={t}
                onClick={() => selectTab(t)}
                className={`rounded-md px-2.5 py-1.5 font-medium transition sm:px-3 ${
                  tab === t ? "bg-white text-brand-800 shadow-sm dark:bg-stone-800 dark:text-brand-100" : "text-stone-600 hover:text-stone-900 dark:text-stone-400"
                }`}
                aria-current={tab === t ? "page" : undefined}
              >
                {t === "search" ? "Search" : "Collections"}
              </button>
            ))}
          </nav>
          <UserMenu user={user} onAccount={() => setDialog("account")} onAdmin={() => setDialog("admin")} onLogout={auth.logout} />
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-4 py-6">
        {error && (
          <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
            {error}
            <button className="ml-3 underline" onClick={() => setError(null)}>
              dismiss
            </button>
          </div>
        )}
        {config && !config.llmConfigured && (
          <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
            OPENROUTER_API_KEY is not set — crawling and natural-language search are disabled.
          </div>
        )}

        {tab === "search" ? (
          <SearchView
            config={config}
            collections={collections}
            groups={groups ?? []}
            scope={scope ?? "all"}
            onSelectScope={selectScope}
            onGoIngest={() => selectTab("ingest")}
          />
        ) : (
          <IngestView
            config={config}
            collections={collections}
            groups={groups ?? []}
            feed={feed}
            onChanged={refreshCollections}
            onSearch={(s) => {
              selectScope(s);
              selectTab("search");
            }}
          />
        )}
      </main>
      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
      {dialog === "account" && <AccountModal user={user} onUpdated={auth.setUser} onClose={() => setDialog(null)} />}
      {dialog === "admin" && <AdminModal me={user} onClose={() => setDialog(null)} />}
    </div>
  );
}
