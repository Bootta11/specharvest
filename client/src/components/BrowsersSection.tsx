import { useEffect, useState } from "react";
import type { BrowserPatch, BrowserStatus, BrowserTestResult, CapacityRun } from "@specharvest/shared";
import { api } from "../lib/api.ts";
import { CapacityPanel, capacityPercent } from "./CapacityPanel.tsx";
import { Notice } from "./Modal.tsx";

interface Draft {
  name: string;
  url: string;
  apiKey: string;
  clearApiKey: boolean;
  username: string;
  password: string;
  clearPassword: boolean;
  tabs: string;
  allowProxy: boolean;
}

const emptyDraft: Draft = { name: "", url: "", apiKey: "", clearApiKey: false, username: "", password: "", clearPassword: false, tabs: "", allowProxy: true };

const draftOf = (b: BrowserStatus): Draft => ({
  ...emptyDraft,
  name: b.name,
  url: b.url ?? "",
  username: b.username ?? "",
  tabs: b.tabs == null ? "" : String(b.tabs),
  allowProxy: b.allowProxy,
});

const ago = (t: number) => {
  const m = Math.round((Date.now() - t) / 60_000);
  if (m < 60) return `${Math.max(1, m)} min ago`;
  if (m < 48 * 60) return `${Math.round(m / 60)} h ago`;
  return `${Math.round(m / 1440)} days ago`;
};

const stateClass: Record<string, string> = {
  up: "text-emerald-700 dark:text-emerald-400",
  down: "text-red-700 dark:text-red-400",
  draining: "text-amber-700 dark:text-amber-400",
};

/** The remote browsers crawl pages run in: .env ones (read-only) and ones added here, each with its own keys. */
export function BrowsersSection() {
  const [browsers, setBrowsers] = useState<BrowserStatus[] | null>(null);
  /** null: no form; "new": adding; a number: editing that browser. */
  const [editing, setEditing] = useState<"new" | number | null>(null);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [test, setTest] = useState<BrowserTestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [run, setRun] = useState<CapacityRun | null>(null);
  const [showRun, setShowRun] = useState(true);

  const fail = (value: unknown) => setError((value as Error).message);
  const load = () => api.browsers().then(setBrowsers, fail);
  const loadRun = () => api.capacityTest().then((r) => setRun(r.run), fail);
  // Every second while a capacity test runs (its progress lives on the server), else every 5 s.
  const testing = !!run?.running;
  useEffect(() => {
    load();
    loadRun();
    const timer = setInterval(
      () => {
        loadRun();
        if (!testing) load();
      },
      testing ? 1000 : 5000,
    );
    const slow = testing ? setInterval(load, 5000) : undefined;
    return () => {
      clearInterval(timer);
      clearInterval(slow);
    };
  }, [testing]);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      return true;
    } catch (err) {
      fail(err);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const open = (target: "new" | BrowserStatus) => {
    setEditing(target === "new" ? "new" : target.id);
    setDraft(target === "new" ? emptyDraft : draftOf(target));
    setTest(null);
    setError(null);
  };
  const close = () => {
    setEditing(null);
    setTest(null);
  };
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => ({ ...d, [key]: value }));

  const current = typeof editing === "number" ? browsers?.find((b) => b.id === editing) : undefined;

  const save = () => {
    const tabs = draft.tabs.trim() ? Number(draft.tabs) : null;
    if (tabs != null && (!Number.isInteger(tabs) || tabs < 1)) return setError("Pages at once must be a whole number of at least 1 (or empty)");
    const body: BrowserPatch = { name: draft.name.trim(), url: draft.url.trim(), username: draft.username.trim() || null, tabs, allowProxy: draft.allowProxy };
    // Secrets: typed = replace, "clear" = remove, empty = keep the saved one.
    if (draft.apiKey) body.apiKey = draft.apiKey;
    else if (draft.clearApiKey) body.apiKey = null;
    if (draft.password) body.password = draft.password;
    else if (draft.clearPassword) body.password = null;
    void act(async () => {
      setBrowsers(editing === "new" ? await api.createBrowser({ ...body, name: body.name!, url: body.url! }) : await api.updateBrowser(editing as number, body));
    }).then((ok) => ok && close());
  };

  const runTest = () =>
    void act(async () => {
      setTest(null);
      setTest(
        await api.testBrowser({
          ...(typeof editing === "number" ? { id: editing } : {}),
          url: draft.url.trim() || undefined,
          apiKey: draft.apiKey || undefined,
          username: draft.username.trim() || undefined,
          password: draft.password || undefined,
        }),
      );
    });

  const startTest = (b: BrowserStatus) => {
    const others = (browsers ?? []).filter((o) => o.name !== b.name && o.enabled);
    const warning = others.length ? "" : "\n\nIt's the only browser, so crawls wait until the test ends.";
    if (!window.confirm(`Test how many pages ${b.name} can run at once?\n\nIt takes about 3–5 min, and ${b.name} takes no crawl pages meanwhile (its open pages finish first).${warning}`)) return;
    void act(async () => {
      setRun((await api.startCapacityTest(b.name)).run);
      setShowRun(true);
    });
  };
  const stopTest = () => void act(async () => setRun((await api.stopCapacityTest()).run));
  const runBrowser = run ? browsers?.find((b) => b.name === run.browser) : undefined;

  const toggle = (b: BrowserStatus) => void act(async () => setBrowsers(await api.updateBrowser(b.id!, { enabled: !b.enabled })));
  const remove = (b: BrowserStatus) => {
    if (!window.confirm(`Delete browser "${b.name}"? Its open pages finish first.`)) return;
    void act(async () => setBrowsers(await api.deleteBrowser(b.id!)));
  };

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold">Browsers</h3>
        {editing === null && (
          <button className="btn-secondary" disabled={busy} onClick={() => open("new")}>
            Add browser
          </button>
        )}
      </div>
      <p className="text-xs text-stone-500">Remote Chrome browsers (ws:// or wss://) that crawl pages run in. Each new page goes to the browser with the most free pages.</p>
      {error && <Notice kind="error">{error}</Notice>}
      {!browsers ? (
        <p className="text-sm text-stone-500">Loading…</p>
      ) : (
        <ul className="divide-y divide-stone-200 text-sm dark:divide-stone-800">
          {browsers.length === 0 && <li className="py-2 text-stone-500">No browsers yet — add one.</li>}
          {browsers.map((b) => (
            <li key={b.id ?? `env-${b.name}`} className="flex flex-col gap-2 py-2 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{b.name}</span>
                  {b.source === "env" && <span className="rounded bg-stone-100 px-1.5 py-0.5 text-xs text-stone-600 dark:bg-stone-800 dark:text-stone-300">from .env</span>}
                  {!b.allowProxy && <span className="rounded bg-stone-100 px-1.5 py-0.5 text-xs text-stone-600 dark:bg-stone-800 dark:text-stone-300">no proxy</span>}
                </div>
                <div className="truncate text-xs text-stone-500">
                  {b.host}
                  {b.apiKey.set && ` · key …${b.apiKey.last4}`}
                  {b.username && ` · user ${b.username}`}
                </div>
                {run?.running && run.browser === b.name ? (
                  <div className="text-xs font-medium text-brand-700 dark:text-brand-500">testing… {capacityPercent(run)}%</div>
                ) : (
                  b.capacity && (
                    <div className="text-xs text-stone-500">
                      tested {ago(b.capacity.testedAt)} · {b.capacity.recommended ? `best at ${b.capacity.recommended} pages` : "no recommendation"} ({b.capacity.bestPagesPerMin.toFixed(0)}/min)
                    </div>
                  )
                )}
                {(b.apiKey.warning || b.password.warning) && <div className="text-xs text-amber-700 dark:text-amber-400">{b.apiKey.warning ?? b.password.warning}</div>}
              </div>
              <div className="flex flex-wrap items-center gap-2 sm:justify-end">
                <span className="text-xs">
                  {b.live ? (
                    <>
                      <span className={stateClass[b.live.state]}>{b.live.state}</span> · {b.live.active}/{b.live.tabs} busy · {b.live.pages} pages
                    </>
                  ) : b.enabled ? (
                    "starting…"
                  ) : (
                    <span className="text-stone-500">off</span>
                  )}
                </span>
                <button className="btn-secondary" disabled={busy || testing} title="Find how many pages this browser handles at once" onClick={() => startTest(b)}>
                  Test capacity
                </button>
                {b.source === "app" && (
                  <>
                    <label className="flex items-center gap-1 text-xs">
                      <input type="checkbox" checked={b.enabled} disabled={busy || run?.running && run.browser === b.name} onChange={() => toggle(b)} />
                      On
                    </label>
                    <button className="btn-secondary" disabled={busy || editing !== null || (testing && run?.browser === b.name)} onClick={() => open(b)}>
                      Edit
                    </button>
                    <button className="btn-danger" disabled={busy || editing !== null || (testing && run?.browser === b.name)} onClick={() => remove(b)}>
                      Delete
                    </button>
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {run && (showRun || run.running) && (
        <CapacityPanel
          run={run}
          busy={busy}
          onStop={stopTest}
          onClose={() => setShowRun(false)}
          onApply={
            runBrowser?.id != null
              ? (tabs) => void act(async () => setBrowsers(await api.updateBrowser(runBrowser.id!, { tabs })))
              : null
          }
        />
      )}
      {browsers?.some((b) => b.source === "env") && <p className="text-xs text-stone-500">Browsers from .env (PUPPETEER_WS_ENDPOINT) share the PUPPETEER_WS_* keys and can be changed only there.</p>}

      {editing !== null && (
        <div className="space-y-3 rounded border border-stone-200 p-3 dark:border-stone-800">
          <h4 className="text-sm font-semibold">{editing === "new" ? "Add browser" : `Edit ${current?.name ?? "browser"}`}</h4>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-sm">
              Name
              <input className="input mt-1 w-full" value={draft.name} placeholder="e.g. hetzner-1" onChange={(e) => set("name", e.target.value)} />
            </label>
            <label className="text-sm">
              Pages at once
              <input className="input mt-1 w-full" type="number" min="1" value={draft.tabs} placeholder={`default (${browsers?.[0]?.defaultTabs ?? 2})`} onChange={(e) => set("tabs", e.target.value)} />
            </label>
            <label className="text-sm sm:col-span-2">
              URL
              <input className="input mt-1 w-full" value={draft.url} placeholder="wss://browser.example.com" autoComplete="off" onChange={(e) => set("url", e.target.value)} />
            </label>
            <label className="text-sm">
              <span className="flex justify-between gap-2">
                API key (X-Api-Key)
                {current?.apiKey.set && (
                  <button type="button" className="text-xs text-brand-700" onClick={() => set("clearApiKey", !draft.clearApiKey)}>
                    {draft.clearApiKey ? "keep" : "clear"}
                  </button>
                )}
              </span>
              <input
                className="input mt-1 w-full"
                type="password"
                autoComplete="new-password"
                value={draft.apiKey}
                disabled={draft.clearApiKey}
                placeholder={draft.clearApiKey ? "will be removed" : current?.apiKey.set ? `saved · …${current.apiKey.last4} (type to replace)` : "optional"}
                onChange={(e) => set("apiKey", e.target.value)}
              />
            </label>
            <label className="text-sm">
              Username (Basic auth)
              <input className="input mt-1 w-full" value={draft.username} autoComplete="off" placeholder="optional" onChange={(e) => set("username", e.target.value)} />
            </label>
            <label className="text-sm">
              <span className="flex justify-between gap-2">
                Password
                {current?.password.set && (
                  <button type="button" className="text-xs text-brand-700" onClick={() => set("clearPassword", !draft.clearPassword)}>
                    {draft.clearPassword ? "keep" : "clear"}
                  </button>
                )}
              </span>
              <input
                className="input mt-1 w-full"
                type="password"
                autoComplete="new-password"
                value={draft.password}
                disabled={draft.clearPassword}
                placeholder={draft.clearPassword ? "will be removed" : current?.password.set ? "saved (type to replace)" : "optional"}
                onChange={(e) => set("password", e.target.value)}
              />
            </label>
            <label className="flex items-center gap-2 self-end text-sm">
              <input type="checkbox" checked={draft.allowProxy} onChange={(e) => set("allowProxy", e.target.checked)} />
              Allow proxy pages (PROXY_SERVER)
            </label>
          </div>
          {test && (test.ok ? <Notice kind="ok">Connected · {test.version}</Notice> : <Notice kind="error">Can't connect: {test.error}</Notice>)}
          <div className="flex flex-wrap gap-2">
            <button className="btn-secondary" disabled={busy || (!draft.url.trim() && editing === "new")} onClick={runTest}>
              {busy ? "Working…" : "Test"}
            </button>
            <button className="btn-primary" disabled={busy || !draft.name.trim() || !draft.url.trim()} onClick={save}>
              Save
            </button>
            <button className="btn-secondary" disabled={busy} onClick={close}>
              Cancel
            </button>
          </div>
          <p className="text-xs text-stone-500">Keys are stored encrypted and never shown again. Leave a key field empty to keep the saved one. Saving a change lets the browser's open pages finish first.</p>
        </div>
      )}
    </section>
  );
}
