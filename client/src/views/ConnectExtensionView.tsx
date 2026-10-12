import { useState } from "react";
import { pairingCode, type UserSummary } from "@specharvest/shared";
import { api } from "../lib/api.ts";

export const CONNECT_EXTENSION_PATH = "/connect-extension";

/**
 * Opened by the SpecHarvest extension ("Approve on the website"): the signed-in user lets that browser
 * crawl for their account. The page only sees a challenge — the extension claims the token itself.
 */
export function ConnectExtensionView({ user, onDone }: { user: UserSummary; onDone: () => void }) {
  const params = new URLSearchParams(location.search);
  const challenge = params.get("challenge") ?? "";
  const [deviceName, setDeviceName] = useState((params.get("device") ?? "").slice(0, 80) || "Chrome");
  const [state, setState] = useState<"ask" | "busy" | "approved" | { error: string }>("ask");
  const valid = /^[\w-]{43}$/.test(challenge);

  const approve = async () => {
    setState("busy");
    try {
      await api.approveExtension(challenge, deviceName.trim() || "Chrome");
      setState("approved");
    } catch (err) {
      setState({ error: (err as Error).message });
    }
  };

  const leave = () => {
    history.replaceState(null, "", "/");
    onDone();
  };

  return (
    <div className="grid min-h-dvh place-items-center bg-stone-50 px-4 py-8 dark:bg-stone-950">
      <div className="card w-full max-w-md p-5 sm:p-6">
        <div className="mb-4 flex items-center gap-3">
          <img src="/logo.png" alt="" className="size-9" />
          <h1 className="text-lg font-semibold">Connect a browser</h1>
        </div>
        {!valid ? (
          <>
            <p className="text-sm text-stone-600 dark:text-stone-300">This link is incomplete. Start again from the SpecHarvest extension's settings.</p>
            <button className="btn-ghost mt-4" onClick={leave}>
              Go to SpecHarvest
            </button>
          </>
        ) : state === "approved" ? (
          <>
            <p className="text-sm">
              <strong>{deviceName}</strong> is connected to your account. The extension picks it up within a few seconds — you can close this tab.
            </p>
            <button className="btn-ghost mt-4" onClick={leave}>
              Go to SpecHarvest
            </button>
          </>
        ) : (
          <>
            <p className="text-sm text-stone-600 dark:text-stone-300">
              The SpecHarvest extension wants to crawl pages in this browser for <strong>{user.email}</strong>. Crawls you start can then run there.
            </p>
            <div className="mt-4 rounded-lg bg-stone-100 p-3 text-center dark:bg-stone-800">
              <div className="text-xs text-stone-500">The extension shows the code</div>
              <div className="mt-1 font-mono text-2xl font-semibold tracking-widest">{pairingCode(challenge)}</div>
            </div>
            <p className="mt-2 text-xs text-stone-500">Only approve if it matches — and only if you just clicked Connect in the extension yourself.</p>
            <label className="mt-4 flex flex-col gap-1 text-sm">
              Name for this browser
              <input className="input" value={deviceName} maxLength={80} onChange={(e) => setDeviceName(e.target.value)} />
            </label>
            {typeof state === "object" && <p className="mt-3 text-sm text-red-700 dark:text-red-300">{state.error}</p>}
            <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <button className="btn-ghost" onClick={leave}>
                Don't connect
              </button>
              <button className="btn-primary" disabled={state === "busy"} onClick={() => void approve()}>
                {state === "busy" ? "Connecting…" : "Approve"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
