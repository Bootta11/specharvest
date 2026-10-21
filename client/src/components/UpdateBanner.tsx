import { useEffect, useState } from "react";
import {
  availableRelease,
  canInstall,
  canSelfUpdate,
  installRelease,
  onReleaseChange,
  openInstallSettings,
  type ApkRelease,
} from "../lib/apk-update.ts";
import { appUpdateNeeded, onAppUpdateNeeded } from "../lib/updates.ts";

const DISMISSED_KEY = "updateDismissed";

function dismissedVersion(): number {
  try {
    return Number(localStorage.getItem(DISMISSED_KEY)) || 0;
  } catch {
    return 0;
  }
}

/**
 * Android app: "Version X is available" with Update / Later (docs/app-updates.md). Floats at the bottom on every
 * screen, sign-in included. "Later" hides it until a newer version comes out. When the server's UI needs a newer
 * APK, it says so; the Play build, which can't install updates itself, points to Google Play instead.
 */
export function UpdateBanner() {
  const [release, setRelease] = useState<ApkRelease | null>(availableRelease);
  const [needed, setNeeded] = useState<number | null>(appUpdateNeeded);
  const [dismissed, setDismissed] = useState(dismissedVersion);
  const [state, setState] = useState<{ step: "idle" } | { step: "permission" } | { step: "downloading"; percent: number } | { step: "error"; message: string }>({
    step: "idle",
  });

  useEffect(() => onReleaseChange(() => setRelease(availableRelease())), []);
  useEffect(() => onAppUpdateNeeded(() => setNeeded(appUpdateNeeded())), []);

  const selfUpdate = canSelfUpdate();
  const shown = release ? release.versionCode > dismissed : needed !== null && !selfUpdate && needed > dismissed;
  if (!shown) return null;

  const later = () => {
    const version = release?.versionCode ?? needed ?? 0;
    try {
      localStorage.setItem(DISMISSED_KEY, String(version));
    } catch {
      /* per-session then */
    }
    setDismissed(version);
  };

  const update = async () => {
    if (!release) return;
    try {
      if (!(await canInstall())) return setState({ step: "permission" });
      setState({ step: "downloading", percent: 0 });
      await installRelease(release, (percent) => setState({ step: "downloading", percent }));
      setState({ step: "idle" });
    } catch (err) {
      setState({ step: "error", message: err instanceof Error ? err.message : String(err) });
    }
  };

  const title = release ? `Version ${release.versionName} is available` : "A newer app version is needed";
  const body = release
    ? needed !== null
      ? "The newest features on your server need it."
      : release.changelog
    : "Your server's newest features need a newer app. Update SpecHarvest from Google Play.";

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex justify-center px-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
      <div
        role="status"
        className="pointer-events-auto w-full max-w-md rounded-xl border border-brand-100 bg-white p-4 text-sm shadow-lg dark:border-brand-900 dark:bg-stone-900"
      >
        <p className="font-medium text-stone-900 dark:text-stone-100">{title}</p>
        {body && <p className="mt-1 line-clamp-4 whitespace-pre-line text-stone-600 dark:text-stone-400">{body}</p>}

        {state.step === "permission" && (
          <p className="mt-2 text-amber-800 dark:text-amber-300">
            Android needs your OK first: turn on <strong>Allow from this source</strong> for SpecHarvest, then come back
            and tap Update again.
          </p>
        )}
        {state.step === "downloading" && (
          <div className="mt-3">
            <div className="h-1.5 overflow-hidden rounded-full bg-stone-200 dark:bg-stone-700">
              <div className="h-full bg-brand-600 transition-[width]" style={{ width: `${state.percent}%` }} />
            </div>
            <p className="mt-1 tabular-nums text-stone-500">Downloading… {state.percent}%</p>
          </div>
        )}
        {state.step === "error" && <p className="mt-2 text-red-700 dark:text-red-300">Update failed: {state.message}</p>}

        <div className="mt-3 flex flex-wrap justify-end gap-2">
          <button className="btn-ghost" onClick={later} disabled={state.step === "downloading"}>
            Later
          </button>
          {release && state.step === "permission" && (
            <button className="btn-primary" onClick={() => void openInstallSettings()}>
              Open settings
            </button>
          )}
          {release && (
            <button className="btn-primary" onClick={() => void update()} disabled={state.step === "downloading"}>
              Update
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
