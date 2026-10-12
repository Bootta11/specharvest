import { useEffect, useState, type FormEvent } from "react";
import type { ExtensionDevice } from "@specharvest/shared";
import { api } from "../lib/api.ts";
import { Notice, OneTimeSecret } from "./Modal.tsx";

const date = (ts: number | null) => (ts ? new Date(ts).toLocaleDateString() : "never");

/** Browsers with the SpecHarvest extension connected to this account (extension tokens), and a token to paste. */
export function ConnectedBrowsers() {
  const [devices, setDevices] = useState<ExtensionDevice[] | null>(null);
  const [name, setName] = useState("");
  const [created, setCreated] = useState<{ token: string; device: ExtensionDevice } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () => api.extensionDevices().then(setDevices, (err) => setError((err as Error).message));
  useEffect(() => {
    load();
  }, []);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      setCreated(await api.createExtensionToken(name.trim()));
      setName("");
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const revoke = async (d: ExtensionDevice) => {
    if (!window.confirm(`Disconnect "${d.name}"? Crawls running in it stop (you can resume them).`)) return;
    await api.revokeExtensionDevice(d.id).catch((err) => setError((err as Error).message));
    if (created?.device.id === d.id) setCreated(null);
    load();
  };

  return (
    <section className="space-y-3">
      <div>
        <h3 className="text-sm font-semibold">Connected browsers</h3>
        <p className="text-xs text-stone-500">
          The SpecHarvest Chrome extension loads crawl pages in your own browser. Connect it from the extension (approve here when asked), or create a token
          and paste it into the extension's settings.
        </p>
      </div>
      {error && <Notice kind="error">{error}</Notice>}
      {created && <OneTimeSecret label={`Token for "${created.device.name}" — paste it into the extension`} value={created.token} />}
      <form onSubmit={create} className="flex gap-2">
        <input className="input" placeholder="Browser name, e.g. Work laptop" required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
        <button className="btn-ghost">Create token</button>
      </form>
      {devices && devices.length > 0 && (
        <ul className="divide-y divide-stone-200 rounded-lg border border-stone-200 text-sm dark:divide-stone-800 dark:border-stone-800">
          {devices.map((d) => (
            <li key={d.id} className="flex items-center gap-3 px-3 py-2">
              <span className={`size-2 shrink-0 rounded-full ${d.online ? "bg-emerald-500" : "bg-stone-300 dark:bg-stone-600"}`} title={d.online ? "Connected now" : "Offline"} />
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{d.name}</div>
                <div className="truncate text-xs text-stone-500">
                  {d.online ? "connected now" : `last seen ${date(d.lastUsedAt)}`} · {d.via === "approve" ? "approved" : "token"} <code>{d.keyPrefix}…</code>
                </div>
              </div>
              <button className="btn-ghost btn-sm text-red-700 dark:text-red-300" onClick={() => revoke(d)}>
                Disconnect
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
