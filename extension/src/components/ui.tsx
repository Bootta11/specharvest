import { useEffect, useState } from "react";
import { getSettings, type Settings } from "../lib/settings.ts";
import { getState, onStateChange, type ConnectionStatus, type LiveState } from "../lib/state.ts";

/** The background worker's live state, kept current. */
export function useLiveState(): LiveState | null {
  const [state, setState] = useState<LiveState | null>(null);
  useEffect(() => {
    void getState().then(setState);
    return onStateChange(setState);
  }, []);
  return state;
}

/** Saved settings, re-read whenever they change. */
export function useSettings(): [Settings | null, () => void] {
  const [settings, setSettings] = useState<Settings | null>(null);
  const reload = () => void getSettings().then(setSettings);
  useEffect(() => {
    reload();
    const listener = (_: unknown, area: string) => area === "local" && reload();
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }, []);
  return [settings, reload];
}

const STATUS: Record<ConnectionStatus, { label: string; dot: string }> = {
  online: { label: "Connected", dot: "bg-emerald-500" },
  connecting: { label: "Connecting…", dot: "bg-amber-400 animate-pulse" },
  offline: { label: "Offline", dot: "bg-stone-400" },
  error: { label: "Not connected", dot: "bg-red-500" },
  unconfigured: { label: "Not connected", dot: "bg-stone-300 dark:bg-stone-600" },
};

export function StatusDot({ status }: { status: ConnectionStatus }) {
  const s = STATUS[status];
  return (
    <span className="inline-flex items-center gap-2 text-sm font-medium">
      <span className={`size-2.5 rounded-full ${s.dot}`} aria-hidden />
      {s.label}
    </span>
  );
}

export function send(msg: import("../lib/state.ts").BackgroundRequest): Promise<{ ok: boolean; error?: string }> {
  return chrome.runtime.sendMessage(msg);
}

export function Logo({ className = "size-6" }: { className?: string }) {
  return <img src="/icon/48.png" alt="" className={className} />;
}
