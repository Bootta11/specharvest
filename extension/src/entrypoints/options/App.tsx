import { useEffect, useState, type ReactNode } from "react";
import { EXTENSION_MAX_CONCURRENCY } from "@specharvest/shared";
import { Logo, send, StatusDot, useLiveState, useSettings } from "../../components/ui.tsx";
import { whoami } from "../../lib/api.ts";
import { addServer } from "../../lib/pairing.ts";
import { hasAllSites, removeAllSites, requestAllSites, requestSitePermission, requestSites } from "../../lib/permissions.ts";
import { defaultDeviceName, getSettings, normalizeServerUrl, patchServer, saveSettings, tabShares, type ServerEntry, type Settings, type TabMode } from "../../lib/settings.ts";
import { serverStatus, type LiveState } from "../../lib/state.ts";
import { blockedReason, originPatterns, siteOf } from "../../lib/url-guard.ts";

const TAB_MODES: Array<{ value: TabMode; label: string; hint: string }> = [
  { value: "minimized", label: "Separate minimized window", hint: "Out of your way. Recommended." },
  { value: "background", label: "Separate window in the background", hint: "Every page renders, as if you were looking at it." },
  { value: "group", label: "Tab group in your current window", hint: "A collapsed “SpecHarvest” group you can watch." },
];

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="card p-4 sm:p-5">
      <h2 className="mb-3 text-base font-semibold">{title}</h2>
      {children}
    </section>
  );
}

export function OptionsApp() {
  const state = useLiveState();
  const [settings] = useSettings();
  if (!state || !settings) return null;
  const onlineIds = settings.servers.filter((x) => serverStatus(state, x.id).status === "online").map((x) => x.id);
  const shares = tabShares(settings, onlineIds);

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-4 px-4 py-6 sm:py-10">
      <header className="flex items-center gap-3">
        <Logo className="size-9" />
        <div>
          <h1 className="text-xl font-semibold">SpecHarvest</h1>
          <p className="text-sm text-stone-500">Crawl shop listings in your own Chrome</p>
        </div>
      </header>

      <Section title={settings.servers.length > 1 ? "Servers" : "Server"}>
        <Servers settings={settings} state={state} shares={shares} />
      </Section>

      <Section title="Crawling">
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 text-sm text-stone-600 dark:text-stone-400">Where crawl tabs open</legend>
          {TAB_MODES.map((m) => (
            <label key={m.value} className="flex cursor-pointer items-start gap-3 rounded-lg border border-stone-200 p-3 has-checked:border-brand-600 dark:border-stone-800">
              <input
                type="radio"
                name="tabMode"
                className="mt-0.5 size-4 accent-brand-700"
                checked={settings.tabMode === m.value}
                onChange={() => void saveSettings({ tabMode: m.value })}
              />
              <span>
                <span className="block text-sm font-medium">{m.label}</span>
                <span className="block text-xs text-stone-500">{m.hint}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <label className="mt-4 flex flex-wrap items-center gap-3 text-sm">
          Tabs at once{settings.servers.length > 1 && " (whole browser)"}
          <select
            className="input h-9 w-20"
            value={settings.concurrency}
            onChange={async (e) => {
              await saveSettings({ concurrency: Number(e.target.value) });
              await send({ type: "settingsChanged" });
            }}
          >
            {Array.from({ length: EXTENSION_MAX_CONCURRENCY }, (_, i) => i + 1).map((n) => (
              <option key={n}>{n}</option>
            ))}
          </select>
          <span className="text-xs text-stone-500">Fewer is gentler on your computer and on the sites.</span>
        </label>
        {settings.servers.length > 1 && (
          <p className="mt-1 text-xs text-stone-500">
            Shared between the servers that are online:{" "}
            {settings.servers
              .filter((x) => onlineIds.includes(x.id))
              .map((x) => `${new URL(x.serverUrl).host} ${shares.get(x.id)}`)
              .join(" · ") || "none online right now"}
            . Give a server a fixed number under Servers.
          </p>
        )}
        {settings.tabMode !== "background" && (
          <label className="mt-4 flex cursor-pointer items-start gap-3 text-sm">
            <input
              type="checkbox"
              className="mt-0.5 size-4 shrink-0 accent-brand-700"
              checked={settings.autoVisible}
              onChange={async (e) => {
                await saveSettings({ autoVisible: e.target.checked });
                await send({ type: "settingsChanged" });
              }}
            />
            <span>
              <span className="block font-medium">Use a background window for sites that load more items as you scroll (recommended)</span>
              <span className="block text-xs text-stone-500">
                Hidden pages don't scroll, so such sites would only show their first items. The crawl moves to a window behind yours, and the site is
                remembered.
              </span>
            </span>
          </label>
        )}
      </Section>

      <Section title="Sites">
        <Sites pending={state.pendingPermissions.map((p) => p.origin)} visibleSites={settings.visibleSites} />
      </Section>

      <p className="px-1 text-xs leading-relaxed text-stone-500">
        The extension opens only the pages your SpecHarvest crawls ask for, on sites you allowed, and sends their text to your SpecHarvest server — nowhere
        else. It never reads your other tabs.
      </p>
    </main>
  );
}

function Servers({ settings, state, shares }: { settings: Settings; state: LiveState; shares: Map<string, number> }) {
  const [adding, setAdding] = useState(false);
  const pairing = state.pairing;
  const showForm = adding || settings.servers.length === 0;
  return (
    <div className="flex flex-col gap-3">
      {settings.servers.map((x) => (
        <ServerRow key={x.id} server={x} state={state} share={shares.get(x.id) ?? 1} several={settings.servers.length > 1} />
      ))}
      {pairing && (
        <div className="rounded-lg bg-brand-50 p-3 text-sm text-brand-900 dark:bg-brand-900/30 dark:text-brand-100">
          {pairing.code ? (
            <>
              Approve in the {new URL(pairing.serverUrl).host} tab. It shows the code <strong className="font-mono">{pairing.code}</strong> — approve only if it
              matches.{" "}
            </>
          ) : null}
          {pairing.message && <span className="block text-xs opacity-80">{pairing.message}</span>}
          <button className="underline" onClick={() => void send({ type: "cancelPairing" })}>
            {pairing.code ? "Cancel" : "Dismiss"}
          </button>
        </div>
      )}
      {showForm ? (
        <div className={settings.servers.length ? "border-t border-stone-100 pt-3 dark:border-stone-800" : ""}>
          {settings.servers.length > 0 && <h3 className="mb-2 text-sm font-medium">Add a server</h3>}
          <Connect onDone={() => setAdding(false)} />
          {settings.servers.length > 0 && (
            <button className="btn-ghost btn-sm mt-2" onClick={() => setAdding(false)}>
              Cancel
            </button>
          )}
        </div>
      ) : (
        <button className="btn-ghost btn-sm self-start" onClick={() => setAdding(true)}>
          + Add another server
        </button>
      )}
    </div>
  );
}

function ServerRow({ server, state, share, several }: { server: ServerEntry; state: LiveState; share: number; several: boolean }) {
  const [confirming, setConfirming] = useState(false);
  const st = serverStatus(state, server.id);
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-stone-200 p-3 dark:border-stone-800">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 text-sm">
          <div className="truncate font-medium">{new URL(server.serverUrl).host}</div>
          <div className="truncate text-stone-500">
            {server.email || "Signed out"}
            {server.deviceName && ` · ${server.deviceName}`}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {confirming ? (
            <>
              <button className="btn-primary btn-sm" onClick={() => void send({ type: "removeServer", serverId: server.id })}>
                Disconnect and remove
              </button>
              <button className="btn-ghost btn-sm" onClick={() => setConfirming(false)}>
                Keep
              </button>
            </>
          ) : (
            <>
              <button className="btn-ghost btn-sm" onClick={() => void send({ type: "reconnect", serverId: server.id })}>
                Reconnect
              </button>
              <button className="btn-ghost btn-sm" onClick={() => setConfirming(true)}>
                Disconnect
              </button>
            </>
          )}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        <StatusDot status={st.status} />
        {st.message && <span className="text-stone-500">{st.message}</span>}
        {several && (
          <label className="ml-auto flex items-center gap-2 text-xs text-stone-500">
            Tabs
            <select
              className="input h-8 w-28"
              value={server.tabLimit ?? "auto"}
              onChange={async (e) => {
                await patchServer(server.id, { tabLimit: e.target.value === "auto" ? null : Number(e.target.value) });
                await send({ type: "settingsChanged" });
              }}
            >
              <option value="auto">Auto ({share})</option>
              {Array.from({ length: EXTENSION_MAX_CONCURRENCY }, (_, i) => i + 1).map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
    </div>
  );
}

function Connect({ onDone }: { onDone: () => void }) {
  const [server, setServer] = useState("");
  const [deviceName, setDeviceName] = useState(defaultDeviceName());
  const [mode, setMode] = useState<"approve" | "token">("approve");
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const serverUrl = normalizeServerUrl(server);

  const approve = async () => {
    setError("");
    if (!serverUrl) return setError("Enter your SpecHarvest address, e.g. https://specharvest.example.com");
    await send({ type: "startPairing", serverUrl, deviceName: deviceName.trim() || defaultDeviceName() });
    onDone();
  };

  const connectWithToken = async () => {
    setError("");
    if (!serverUrl) return setError("Enter your SpecHarvest address, e.g. https://specharvest.example.com");
    setBusy(true);
    try {
      const me = await whoami({ serverUrl, token: token.trim() });
      const serverId = await addServer({ serverUrl, token: token.trim(), email: me.email, deviceName: me.deviceName ?? "Chrome (API key)" });
      setToken("");
      await send({ type: "reconnect", serverId });
      onDone();
    } catch (err) {
      const e = err as Error & { status?: number };
      setError(
        e.message === "Failed to fetch"
          ? `Can't reach ${server}`
          : e.status === 401
            ? "That token isn't valid — it may have been revoked. Create a new one under your account → Connected browsers."
            : e.status === 403
              ? "That key can't be used here."
              : e.message,
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <label className="flex flex-col gap-1 text-sm">
        SpecHarvest address
        <input className="input" placeholder="https://specharvest.example.com" value={server} onChange={(e) => setServer(e.target.value)} inputMode="url" />
      </label>
      <div role="tablist" className="flex gap-1 rounded-lg bg-stone-100 p-1 text-sm dark:bg-stone-800">
        {(["approve", "token"] as const).map((m) => (
          <button
            key={m}
            role="tab"
            aria-selected={mode === m}
            className={`flex-1 rounded-md px-3 py-1.5 ${mode === m ? "bg-white font-medium shadow-sm dark:bg-stone-900" : "text-stone-600 dark:text-stone-400"}`}
            onClick={() => setMode(m)}
          >
            {m === "approve" ? "Approve on the website" : "Paste a token"}
          </button>
        ))}
      </div>
      {mode === "approve" ? (
        <>
          <label className="flex flex-col gap-1 text-sm">
            Name for this browser
            <input className="input" value={deviceName} maxLength={80} onChange={(e) => setDeviceName(e.target.value)} />
          </label>
          <button className="btn-primary self-start" onClick={() => void approve()}>
            Connect
          </button>
          <p className="text-xs text-stone-500">Opens SpecHarvest in a new tab. Sign in there if asked, then approve this browser.</p>
        </>
      ) : (
        <>
          <label className="flex flex-col gap-1 text-sm">
            Token
            <input
              className="input font-mono"
              placeholder="shx_…"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <button className="btn-primary self-start" disabled={busy || token.trim().length < 10} onClick={() => void connectWithToken()}>
            {busy ? "Checking…" : "Verify and connect"}
          </button>
          <p className="text-xs text-stone-500">Create one in SpecHarvest under your account → Connected browsers. An API key works too.</p>
        </>
      )}
      {error && <p className="text-sm text-red-600">{error}</p>}
    </div>
  );
}

/** Drops what the extension learned about a site (it checks again on the next crawl). */
async function forgetSite(site: string) {
  const { visibleSites, hiddenOkSites } = await getSettings();
  await saveSettings({ visibleSites: visibleSites.filter((s) => s !== site), hiddenOkSites: hiddenOkSites.filter((s) => s !== site) });
}

/** "olx.ba, https://www.njuskalo.hr/auti\nlocalhost" → sites to allow, and the entries that can't be. */
function parseSites(input: string): { urls: string[]; invalid: string[] } {
  const urls: string[] = [];
  const invalid: string[] = [];
  for (const raw of input.split(/[\s,;]+/).filter(Boolean)) {
    let url: URL | null = null;
    try {
      url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    } catch {}
    const reason = url ? blockedReason(url.href) : "not an address";
    if (!url || reason || !url.hostname.includes(".")) invalid.push(`${raw}${reason ? ` (${reason.toLowerCase()})` : ""}`);
    else urls.push(`https://${siteOf(url.hostname)}/`);
  }
  return { urls: [...new Set(urls)], invalid };
}

/** Allow every site, or a list of sites, ahead of time: Chrome only asks in answer to a click here, never from the phone. */
function AllowInAdvance({ allSites, onChange }: { allSites: boolean; onChange: () => void }) {
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const allowList = async () => {
    const { urls, invalid } = parseSites(text);
    setError(invalid.length ? `Can't allow: ${invalid.join(", ")}` : "");
    if (!urls.length) return;
    const granted = await requestSites(urls).catch((err: Error) => {
      setError(err.message);
      return false;
    });
    if (granted && !invalid.length) setText("");
    onChange();
  };
  return (
    <div className="mb-4 flex flex-col gap-3 border-b border-stone-100 pb-4 dark:border-stone-800">
      <label className="flex cursor-pointer items-start gap-3">
        <input
          type="checkbox"
          className="mt-0.5 size-4 shrink-0 accent-brand-700"
          checked={allSites}
          onChange={async (e) => {
            await (e.target.checked ? requestAllSites() : removeAllSites()).catch(() => false);
            onChange();
          }}
        />
        <span>
          <span className="block font-medium">Allow on all sites</span>
          <span className="block text-xs text-stone-500">
            Crawls never wait for approval, which helps when you start them from your phone (Chrome only asks on this computer). Any server you connected can
            then open any public site in this Chrome, signed in as you. Local and private addresses stay blocked.
          </span>
        </span>
      </label>
      {!allSites && (
        <div className="flex flex-col gap-2">
          <label className="flex flex-col gap-1">
            <span className="font-medium">Allow sites in advance</span>
            <span className="text-xs text-stone-500">The sites you plan to crawl, so crawls started from your phone don't wait. One Chrome prompt for all.</span>
            <textarea
              className="input min-h-16 py-2"
              placeholder="olx.ba, njuskalo.hr"
              value={text}
              onChange={(e) => setText(e.target.value)}
              spellCheck={false}
            />
          </label>
          <button className="btn-primary btn-sm self-start" disabled={!text.trim()} onClick={() => void allowList()}>
            Allow these sites
          </button>
          {error && <p className="text-xs text-red-600">{error}</p>}
        </div>
      )}
    </div>
  );
}

function Sites({ pending, visibleSites }: { pending: string[]; visibleSites: string[] }) {
  const [granted, setGranted] = useState<string[]>([]);
  const [allSites, setAllSites] = useState(false);
  const load = () => {
    void hasAllSites().then(setAllSites);
    void chrome.permissions.getAll().then((p) =>
      setGranted(
        [...new Set((p.origins ?? []).map((o) => o.replace(/^[^:]+:\/\/(\*\.)?/, "").replace(/\/\*$/, "")))]
          // "*" is the all-sites grant, shown as the switch above.
          .filter((site) => site !== "*")
          .sort(),
      ),
    );
  };
  useEffect(() => {
    load();
    chrome.permissions.onAdded.addListener(load);
    chrome.permissions.onRemoved.addListener(load);
    return () => {
      chrome.permissions.onAdded.removeListener(load);
      chrome.permissions.onRemoved.removeListener(load);
    };
  }, []);

  return (
    <div className="flex flex-col gap-2 text-sm">
      <AllowInAdvance allSites={allSites} onChange={load} />
      {pending.map((origin) => (
        <div key={origin} className="flex items-center justify-between gap-3 rounded-lg bg-amber-50 p-2 pl-3 dark:bg-amber-900/20">
          <span className="min-w-0 truncate">
            A crawl is waiting for <strong>{new URL(origin).hostname}</strong>
          </span>
          <button className="btn-primary btn-sm" onClick={() => void requestSitePermission(origin)}>
            Allow
          </button>
        </div>
      ))}
      {granted.length === 0 && pending.length === 0 && !allSites && (
        <p className="text-stone-500">No sites yet — you'll be asked the first time a crawl needs one.</p>
      )}
      {granted.map((site) => (
        <div key={site} className="flex items-center justify-between gap-3 border-b border-stone-100 py-1.5 last:border-0 dark:border-stone-800">
          <span className="min-w-0 truncate">{site}</span>
          <span className="flex shrink-0 items-center gap-1">
            {visibleSites.includes(site) && (
              <button
                className="btn-ghost btn-sm h-7 px-2 text-xs text-stone-500"
                title="This site loads items as you scroll, so its crawls open in a background window. Click to forget."
                onClick={() => void forgetSite(site)}
              >
                visible window ✕
              </button>
            )}
            <button
              className="btn-ghost btn-sm"
              onClick={() =>
                void chrome.permissions
                  .remove({ origins: originPatterns(`https://${site}/`) })
                  .then(() => forgetSite(site))
                  .then(load)
              }
            >
              Remove
            </button>
          </span>
        </div>
      ))}
    </div>
  );
}
