import { useState } from "react";
import { createRoot } from "react-dom/client";
import "../../styles.css";
import { Logo } from "../../components/ui.tsx";
import { requestSitePermission } from "../../lib/permissions.ts";
import { siteOf } from "../../lib/url-guard.ts";

/** Opened from the "Allow SpecHarvest on …?" notification: Chrome's permission prompt needs a click on our own page. */
function Grant() {
  const origin = new URLSearchParams(location.search).get("origin") ?? "";
  let site = "";
  try {
    site = siteOf(new URL(origin).hostname);
  } catch {
    /* bad link */
  }
  const [result, setResult] = useState<"granted" | "denied" | null>(null);
  if (!site) return <p className="p-6 text-sm">Nothing to allow.</p>;

  return (
    <main className="flex min-h-screen flex-col gap-4 p-5">
      <div className="flex items-center gap-2">
        <Logo />
        <h1 className="font-semibold">Allow SpecHarvest on {site}?</h1>
      </div>
      {result === "granted" ? (
        <>
          <p className="text-sm">Allowed — your crawl goes on. You can close this window.</p>
          <button className="btn-ghost self-start" onClick={() => window.close()}>
            Close
          </button>
        </>
      ) : (
        <>
          <p className="text-sm text-stone-600 dark:text-stone-300">
            A crawl you started wants to open pages of <strong>{site}</strong> in your browser and send their text to your SpecHarvest server. You can remove
            access any time in the extension's settings.
          </p>
          <div className="flex gap-2">
            <button
              className="btn-primary"
              onClick={async () => {
                const ok = await requestSitePermission(origin);
                setResult(ok ? "granted" : "denied");
                if (ok) setTimeout(() => window.close(), 1500);
              }}
            >
              Allow on {site}
            </button>
            <button className="btn-ghost" onClick={() => window.close()}>
              Not now
            </button>
          </div>
          {result === "denied" && <p className="text-sm text-red-600">Not allowed — the crawl will stop after a few minutes. You can resume it later.</p>}
        </>
      )}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Grant />);
