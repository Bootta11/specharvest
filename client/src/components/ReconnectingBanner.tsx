import { useServerReconnecting } from "../lib/api.ts";
import type { Auth } from "../lib/auth.ts";
import { isNative, previousAccount } from "../lib/platform.ts";
import { host } from "./AccountRow.tsx";

/** Shorter outages (a dropped stream reconnecting at once) aren't worth a banner. */
const SHOW_AFTER_S = 2;

/**
 * Shown while requests retry or live streams reconnect, e.g. while the server restarts for an update: what's going
 * on and for how long, instead of buttons that seem to hang. `fullscreen` is the boot screen (nothing else to show).
 */
export function ReconnectingBanner({ fullscreen = false, auth }: { fullscreen?: boolean; auth?: Auth }) {
  const seconds = useServerReconnecting();
  if (seconds === null || seconds < SHOW_AFTER_S) return null;
  const banner = (
    <div
      role="status"
      className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200"
    >
      <span className="relative flex size-2 shrink-0">
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-amber-500 opacity-75" />
        <span className="relative inline-flex size-2 rounded-full bg-amber-600" />
      </span>
      <span className="min-w-0 flex-1 basis-56">Can't reach the server — it's probably restarting for an update. Retrying…</span>
      <span className="tabular-nums">{seconds} s</span>
    </div>
  );
  if (!fullscreen) return banner;
  return (
    <div className="grid min-h-dvh place-items-center px-4">
      <div className="w-full max-w-md">
        {banner}
        {auth && <LeaveServerButtons auth={auth} switchLabel="Use another account or server" />}
      </div>
    </div>
  );
}

/**
 * App: ways off a server that isn't answering, without waiting it out — back to the account used before (undoing a
 * switch to a server that's down) or the sign-in screen to pick another account or server.
 */
export function LeaveServerButtons({ auth, switchLabel }: { auth: Auth; switchLabel: string }) {
  if (!isNative) return null;
  const previous = previousAccount();
  return (
    <div className="space-y-2">
      {previous && (
        <button className="btn-primary w-full" onClick={() => void auth.switchTo(previous.id)}>
          <span className="truncate">
            Back to {previous.email || "the previous account"} · {host(previous.server)}
          </span>
        </button>
      )}
      <button className="btn-ghost w-full" onClick={() => void auth.addAccount()}>
        {switchLabel}
      </button>
    </div>
  );
}
