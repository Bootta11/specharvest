import { useEffect, useState, type ReactNode } from "react";
import { EXTENSION_MAX_CONCURRENCY } from "@specharvest/shared";
import { Logo, send, StatusDot, useLiveState, useSettings } from "../../components/ui.tsx";
import { whoami } from "../../lib/api.ts";
import { requestSitePermission } from "../../lib/permissions.ts";
import { defaultDeviceName, getSettings, normalizeServerUrl, saveSettings, type TabMode } from "../../lib/settings.ts";
import { originPatterns } from "../../lib/url-guard.ts";

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
  const connected = !!settings.token;

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-4 px-4 py-6 sm:py-10">
      <header className="flex items-center gap-3">
        <Logo className="size-9" />
        <div>
          <h1 className="text-xl font-semibold">SpecHarvest</h1>
          <p className="text-sm text-stone-500">Crawl shop listings in your own Chrome</p>
        </div>
      </header>

      <Section title="Account">
        {connected ? <Connected email={settings.email} serverUrl={settings.serverUrl} deviceName={settings.deviceName} /> : <Connect initialServer={settings.serverUrl} />}
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          <StatusDot status={state.status} />
          {state.message && <span className="text-stone-500">{state.message}</span>}
        </div>
        {state.pairingCode && (
          <div className="mt-3 rounded-lg bg-brand-50 p-3 text-sm text-brand-900 dark:bg-brand-900/30 dark:text-brand-100">
            Approve in the SpecHarvest tab. It shows the code <strong className="font-mono">{state.pairingCode}</strong> — approve only if it matches.{" "}
            <button className="underline" onClick={() => void send({ type: "cancelPairing" })}>
              Cancel
            </button>
          </div>
        )}
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
          Tabs at once
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

function Connected({ email, serverUrl, deviceName }: { email: string; serverUrl: string; deviceName: string }) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0 text-sm">
        <div className="truncate font-medium">{email || "Connected"}</div>
        <div className="truncate text-stone-500">
          {new URL(serverUrl).host} · {deviceName}
        </div>
      </div>
      <div className="flex gap-2">
        <button className="btn-ghost btn-sm" onClick={() => void send({ type: "reconnect" })}>
          Reconnect
        </button>
        <button className="btn-ghost btn-sm" onClick={() => void send({ type: "disconnect" })}>
          Disconnect
        </button>
      </div>
    </div>
  );
}

function Connect({ initialServer }: { initialServer: string }) {
  const [server, setServer] = useState(initialServer);
  const [deviceName, setDeviceName] = useState(defaultDeviceName());
  const [mode, setMode] = useState<"approve" | "token">("approve");
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const serverUrl = normalizeServerUrl(server);

  const approve = async () => {
    setError("");
    if (!serverUrl) return setError("Enter your SpecHarvest address, e.g. https://specharvest.example.com");
    await saveSettings({ serverUrl });
    await send({ type: "startPairing", serverUrl, deviceName: deviceName.trim() || defaultDeviceName() });
  };

  const connectWithToken = async () => {
    setError("");
    if (!serverUrl) return setError("Enter your SpecHarvest address, e.g. https://specharvest.example.com");
    setBusy(true);
    try {
      const me = await whoami(serverUrl, token.trim());
      await saveSettings({ serverUrl, token: token.trim(), email: me.email, deviceName: me.deviceName ?? "Chrome (API key)" });
      setToken("");
      await send({ type: "reconnect" });
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

function Sites({ pending, visibleSites }: { pending: string[]; visibleSites: string[] }) {
  const [granted, setGranted] = useState<string[]>([]);
  const load = () => void chrome.permissions.getAll().then((p) => setGranted([...new Set((p.origins ?? []).map((o) => o.replace(/^[^:]+:\/\/(\*\.)?/, "").replace(/\/\*$/, "")))].sort()));
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
      {granted.length === 0 && pending.length === 0 && <p className="text-stone-500">No sites yet — you'll be asked the first time a crawl needs one.</p>}
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
