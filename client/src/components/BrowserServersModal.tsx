import { useEffect, useState } from "react";
import type { BurstOptions, BurstSettingKey, BurstSettings, BurstStatus } from "@specharvest/shared";
import { api, formatUsd } from "../lib/api.ts";
import { BrowsersSection } from "./BrowsersSection.tsx";
import { Modal, Notice } from "./Modal.tsx";

const settingRows: Array<{ key: Exclude<BurstSettingKey, "enabled">; label: string; step?: string }> = [
  { key: "maxServers", label: "Maximum servers" },
  { key: "tabs", label: "Pages per server" },
  { key: "minWaiting", label: "Start when pages waiting" },
  { key: "afterSeconds", label: "Waiting time (seconds)" },
  { key: "idleMinutes", label: "Idle timeout (minutes)" },
  { key: "maxMinutes", label: "Maximum lifetime (minutes)" },
  { key: "maxHoursPerDay", label: "Server-hours per UTC day", step: "0.1" },
  { key: "autoRebuildDays", label: "Automatic rebuild every days (0 = off)" },
];

const ago = (timestamp: number | null) => {
  if (!timestamp) return "—";
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 90) return `${seconds}s ago`;
  if (seconds < 7200) return `${Math.round(seconds / 60)}m ago`;
  return `${Math.round(seconds / 3600)}h ago`;
};

export function BrowserServersModal({ onClose }: { onClose: () => void }) {
  const [status, setStatus] = useState<BurstStatus | null>(null);
  const [options, setOptions] = useState<BurstOptions | null>(null);
  const [drafts, setDrafts] = useState<Partial<Record<BurstSettingKey, string>>>({});
  const [token, setToken] = useState("");
  const [allowedIp, setAllowedIp] = useState("");
  const [region, setRegion] = useState("");
  const [size, setSize] = useState("");
  const [tests, setTests] = useState<Record<string, { ok: boolean; error?: string }> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<BurstSettingKey | null>(null);
  const [accountDirty, setAccountDirty] = useState(false);

  const fail = (value: unknown) => setError((value as Error).message);
  const load = () => api.burstStatus().then(setStatus, fail);
  useEffect(() => {
    load();
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!status) return;
    if (!accountDirty) {
      setAllowedIp(status.account.allowedIp ?? "");
      setRegion(status.account.region);
      setSize(status.account.size);
    }
    setDrafts((current) => ({
      ...current,
      ...Object.fromEntries(Object.entries(status.settings).filter(([key]) => key !== editing).map(([key, value]) => [key, String(value)])),
    }));
    if (status.available && !options) api.burstOptions().then(setOptions, fail);
  }, [status, editing, accountDirty, options]);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await load();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  const saveSetting = (key: Exclude<BurstSettingKey, "enabled">, raw = drafts[key]) => {
    if (!status) return;
    const value = Number(raw);
    if (!Number.isFinite(value)) return setDrafts((current) => ({ ...current, [key]: String(status.settings[key]) }));
    if (value !== status.settings[key]) void act(() => api.saveBurstSettings({ [key]: value }));
  };

  const saveAccount = () =>
    act(() =>
      api.saveBurstAccount({
        ...(token ? { token } : {}),
        allowedIp: allowedIp || null,
        region: region || null,
        size: size || null,
      }),
    ).then(() => {
      setToken("");
      setAccountDirty(false);
    });

  const accountLocked = !!status?.running.length || status?.build.running;
  const regionSizes = options?.sizes.filter((item) => item.available && item.regions.includes(region)) ?? [];
  const stale = status?.image?.ageDays != null && status.settings.autoRebuildDays > 0 && status.image.ageDays > status.settings.autoRebuildDays + 3;

  return (
    <Modal title="Browser servers" onClose={onClose}>
      <div className="mb-6">
        <BrowsersSection />
      </div>
      <h3 className="mb-3 border-t border-stone-200 pt-4 text-base font-semibold dark:border-stone-800">Rented servers (DigitalOcean)</h3>
      {error && <Notice kind="error">{error}</Notice>}
      {!status ? (
        <p className="text-sm text-stone-500">Loading…</p>
      ) : (
        <div className="space-y-6">
          <section className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-sm font-semibold">Status</h3>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={status.settings.enabled}
                  disabled={busy || !status.available}
                  onChange={(event) => void act(() => api.saveBurstSettings({ enabled: event.target.checked }))}
                />
                {status.settings.enabled ? "On" : "Off"}
              </label>
            </div>
            {!status.providerEnabled && <p className="rounded bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-100">Set BURST_PROVIDER=digitalocean on the server to enable this feature.</p>}
            {status.providerEnabled && !status.available && <p className="rounded bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-100">Add a DigitalOcean token and allowed IP below. Panel-only setup stays off until you switch it on.</p>}
            <p className="text-sm">
              Today: {status.today.hours.toFixed(2)} of {status.today.limit} server-hours, {formatUsd(status.today.costUsd)}
            </p>
            <ul className="divide-y divide-stone-200 text-sm dark:divide-stone-800">
              {status.running.length === 0 && <li className="py-2 text-stone-500">No servers running.</li>}
              {status.running.map((server) => (
                <li key={server.name} className="flex flex-wrap justify-between gap-2 py-2">
                  <span className="font-medium">{server.name}</span>
                  <span>
                    {server.state} · {server.active}/{server.tabs} busy · {server.pages} pages · {ago(server.startedAt)}
                  </span>
                </li>
              ))}
            </ul>
          </section>

          <section className="space-y-3">
            <h3 className="text-sm font-semibold">DigitalOcean account</h3>
            {accountLocked && <p className="text-xs text-stone-500">Account fields are locked while a server or image build is running.</p>}
            {status.account.token.warning && <p className="rounded bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-100">{status.account.token.warning}</p>}
            <label className="block text-sm">
              Token {status.account.token.set && <span className="text-stone-500">(set · …{status.account.token.last4}, from {status.account.token.source})</span>}
              <input className="input mt-1 w-full" type="password" value={token} disabled={accountLocked} placeholder={status.account.token.set ? "Enter to replace" : "DigitalOcean API token"} onChange={(event) => setToken(event.target.value)} />
            </label>
            <div className="grid gap-3 sm:grid-cols-3">
              <label className="text-sm sm:col-span-1">
                Allowed IP
              <input className="input mt-1 w-full" value={allowedIp} disabled={accountLocked} onChange={(event) => (setAllowedIp(event.target.value), setAccountDirty(true))} />
              </label>
              <label className="text-sm">
                Region
                <select className="input mt-1 w-full" value={region} disabled={accountLocked} onChange={(event) => (setRegion(event.target.value), setAccountDirty(true))}>
                  {(options?.regions ?? [{ slug: region, name: region, available: true }]).filter((item) => item.available).map((item) => (
                    <option key={item.slug} value={item.slug}>{item.name}</option>
                  ))}
                </select>
              </label>
              <label className="text-sm">
                Size
                <select className="input mt-1 w-full" value={size} disabled={accountLocked} onChange={(event) => (setSize(event.target.value), setAccountDirty(true))}>
                  {(regionSizes.length ? regionSizes : [{ slug: size, description: size, priceHourly: status.priceHourly ?? 0, regions: [], available: true }]).map((item) => (
                    <option key={item.slug} value={item.slug}>{item.description} · {formatUsd(item.priceHourly)}/h</option>
                  ))}
                </select>
              </label>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                className="btn-secondary"
                disabled={busy || accountLocked}
                onClick={() =>
                  void act(async () => {
                    setAccountDirty(true);
                    setAllowedIp((await api.detectBurstIp()).ip);
                  })
                }
              >
                Detect IP
              </button>
              <button className="btn-secondary" disabled={busy} onClick={() => void act(async () => setTests(await api.testBurst(token || undefined)))}>Test</button>
              <button className="btn-primary" disabled={busy || accountLocked} onClick={() => void saveAccount()}>Save account</button>
              {status.account.token.source === "app" && <button className="btn-secondary" disabled={busy || accountLocked} onClick={() => void act(() => api.saveBurstAccount({ token: null }))}>Remove token (use env)</button>}
            </div>
            {tests && (
              <ul className="text-xs">
                {Object.entries(tests).map(([scope, result]) => <li key={scope}>{result.ok ? "✓" : "✗"} {scope}{result.error ? ` — ${result.error}` : ""}</li>)}
              </ul>
            )}
            <p className="text-xs text-stone-500">Test checks read scopes. Write scopes are exercised only when creating, updating, or deleting resources; see the deployment docs.</p>
          </section>

          <section className="space-y-3">
            <h3 className="text-sm font-semibold">Settings</h3>
            <div className="grid gap-3 sm:grid-cols-2">
              {settingRows.map(({ key, label, step }) => (
                <label key={key} className="text-sm">
                  <span className="flex justify-between gap-2">
                    {label}
                    {status.overridden.includes(key) && <button type="button" className="text-xs text-brand-700" onClick={() => void act(() => api.saveBurstSettings({ [key]: null }))}>reset</button>}
                  </span>
                  <input
                    className="input mt-1 w-full"
                    type="number"
                    min="0"
                    step={step ?? "1"}
                    value={drafts[key] ?? ""}
                    onFocus={() => setEditing(key)}
                    onChange={(event) => setDrafts((current) => ({ ...current, [key]: event.target.value }))}
                    onBlur={(event) => {
                      setEditing(null);
                      saveSetting(key, event.currentTarget.value);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") saveSetting(key, event.currentTarget.value);
                    }}
                  />
                </label>
              ))}
            </div>
          </section>

          <section className="space-y-3">
            <h3 className="text-sm font-semibold">Image</h3>
            <p className="text-sm">{status.image ? `${status.image.name}${status.image.ageDays == null ? " (server env)" : ` · ${status.image.ageDays.toFixed(1)} days old`}` : "Plain Debian (slower starts)"}</p>
            {stale && <p className="rounded bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-100">The current browser image is overdue for rebuilding.</p>}
            <button className="btn-primary" disabled={busy || status.build.running || !status.available} onClick={() => void act(() => api.rebuildBurstImage())}>Rebuild now</button>
            {status.build.steps.length > 0 && <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded bg-stone-100 p-2 text-xs dark:bg-stone-900">{status.build.steps.join("\n")}</pre>}
            {status.build.lastError && <Notice kind="error">{status.build.lastError}</Notice>}
          </section>

          <section className="space-y-2">
            <h3 className="text-sm font-semibold">Recent servers</h3>
            <ul className="divide-y divide-stone-200 text-sm dark:divide-stone-800">
              {status.history.map((row) => (
                <li key={row.id} className="flex flex-wrap justify-between gap-2 py-2">
                  <span>{row.name} · {new Date(row.startedAt).toLocaleString()}</span>
                  <span>{row.endedAt ? `${((row.endedAt - row.startedAt) / 60_000).toFixed(1)} min` : "running"} · {row.pages} pages · {formatUsd(row.costUsd ?? 0)} · {row.endReason ?? "—"}</span>
                </li>
              ))}
            </ul>
          </section>
        </div>
      )}
    </Modal>
  );
}
