import { useEffect, useState } from "react";
import { isActiveJob, type Collection, type InspectResult, type Job, type PageSnapshot } from "@specharvest/shared";
import { PAGE_SCRIPTS } from "@specharvest/shared/page-scripts";
import { Logo, StatusDot, useLiveState, useSettings } from "../../components/ui.tsx";
import { inspect, listCollections, listJobs, startCrawl, stopJob } from "../../lib/api.ts";
import { requestSitePermission } from "../../lib/permissions.ts";
import { blockedReason, siteOf } from "../../lib/url-guard.ts";

export function PopupApp() {
  const state = useLiveState();
  const [settings] = useSettings();
  const [tab, setTab] = useState<chrome.tabs.Tab | null>(null);

  useEffect(() => {
    void chrome.tabs.query({ active: true, currentWindow: true }).then(([t]) => setTab(t ?? null));
  }, []);

  if (!state || !settings) return null;
  const connected = !!settings.token;
  const online = state.status === "online";

  return (
    <div className="flex flex-col gap-3 p-3">
      <header className="flex items-center gap-2">
        <Logo />
        <span className="font-semibold">SpecHarvest</span>
        <span className="ml-auto">
          <StatusDot status={state.status} />
        </span>
        <button className="btn-ghost btn-sm px-2" title="Settings" aria-label="Settings" onClick={() => void chrome.runtime.openOptionsPage()}>
          ⚙
        </button>
      </header>

      {!connected ? (
        <div className="card flex flex-col gap-2 p-3 text-sm">
          <p>Connect this browser to your SpecHarvest account so crawls can run here.</p>
          <button className="btn-primary" onClick={() => void chrome.runtime.openOptionsPage()}>
            Connect
          </button>
        </div>
      ) : (
        <>
          {state.message && <p className="text-xs text-stone-500">{state.message}</p>}

          {state.pendingPermissions.map((p) => (
            <div key={p.origin} className="card flex items-center gap-2 border-amber-300 p-2 pl-3 text-sm dark:border-amber-700">
              <span className="min-w-0 flex-1">
                A crawl is waiting to open <strong>{siteOf(new URL(p.origin).hostname)}</strong>
              </span>
              <button className="btn-primary btn-sm" onClick={() => void requestSitePermission(p.origin)}>
                Allow
              </button>
            </div>
          ))}

          {tab?.url && tab.id != null && !blockedReason(tab.url) && online && <ThisPage tabId={tab.id} url={tab.url} title={tab.title ?? ""} />}

          <Jobs serverUrl={settings.serverUrl} />

          <footer className="flex items-center justify-between text-xs text-stone-500">
            <span>{state.openTabs ? `${state.openTabs} crawl tab${state.openTabs === 1 ? "" : "s"} open` : "Idle"}</span>
            <a className="underline" href={settings.serverUrl} target="_blank" rel="noreferrer">
              Open SpecHarvest
            </a>
          </footer>
        </>
      )}
    </div>
  );
}

type Step =
  | { kind: "idle" }
  | { kind: "busy"; label: string }
  | { kind: "verdict"; result: InspectResult }
  | { kind: "pickCollection"; snapshot: PageSnapshot; options: Collection[] }
  | { kind: "started"; job: Job; what: string }
  | { kind: "error"; message: string };

/** The page in the current tab: crawl it as a listing, or add it as one item. */
function ThisPage({ tabId, url, title }: { tabId: number; url: string; title: string }) {
  const [step, setStep] = useState<Step>({ kind: "idle" });
  const site = siteOf(new URL(url).hostname);

  /** Chrome only asks in answer to a click — so this runs first in each click handler. */
  const allow = async () => {
    const granted = await requestSitePermission(url).catch((err: Error) => {
      setStep({ kind: "error", message: `Couldn't ask for access to ${site}: ${err.message}` });
      return null;
    });
    if (granted) return true;
    if (granted === false) setStep({ kind: "error", message: `SpecHarvest needs access to ${site} to read it.` });
    return false;
  };
  const fail = (err: unknown) => setStep({ kind: "error", message: (err as Error)?.message ?? String(err) });

  const crawl = async (force = false) => {
    if (!(await allow())) return;
    try {
      if (!force) {
        setStep({ kind: "busy", label: "Checking the page…" });
        const result = await inspect(url);
        if (result.kind !== "listing") return setStep({ kind: "verdict", result });
      }
      setStep({ kind: "busy", label: "Starting…" });
      setStep({ kind: "started", job: await startCrawl({ url, runner: "browser" }), what: "Crawl started" });
    } catch (err) {
      fail(err);
    }
  };

  const addItem = async () => {
    if (!(await allow())) return;
    try {
      setStep({ kind: "busy", label: "Reading the page…" });
      const [res] = await chrome.scripting.executeScript({ target: { tabId }, world: "ISOLATED", func: PAGE_SCRIPTS.detailSnapshot, args: [{ cardSelector: "", itemPattern: "" }] });
      const snapshot = res?.result as PageSnapshot | undefined;
      if (!snapshot?.text) throw new Error("Couldn't read this page");
      const host = new URL(url).hostname;
      const options = (await listCollections()).filter((c) => c.canEdit && c.host === host).sort((a, b) => b.createdAt - a.createdAt);
      setStep({ kind: "pickCollection", snapshot, options });
    } catch (err) {
      fail(err);
    }
  };

  const confirmAdd = async (snapshot: PageSnapshot, collectionId: number | null) => {
    try {
      setStep({ kind: "busy", label: "Adding…" });
      const job = await startCrawl({ url, kind: "item", runner: "browser", snapshot, ...(collectionId ? { collectionId } : { name: title.slice(0, 200) || site }) });
      setStep({ kind: "started", job, what: "Adding the item" });
    } catch (err) {
      fail(err);
    }
  };

  return (
    <section className="card flex flex-col gap-2 p-3 text-sm">
      <div className="min-w-0">
        <div className="truncate font-medium" title={title}>
          {title || site}
        </div>
        <div className="truncate text-xs text-stone-500">{site}</div>
      </div>

      {step.kind === "idle" && (
        <div className="grid grid-cols-2 gap-2">
          <button className="btn-primary btn-sm" onClick={() => void crawl()}>
            Crawl this listing
          </button>
          <button className="btn-ghost btn-sm" onClick={() => void addItem()}>
            Add this item
          </button>
        </div>
      )}
      {step.kind === "busy" && <p className="text-stone-500">{step.label}</p>}
      {step.kind === "verdict" && (
        <div className="flex flex-col gap-2">
          <p>
            {step.result.kind === "item" ? "This looks like a single item, not a listing." : "This doesn't look like a shop listing."}{" "}
            <span className="text-stone-500">{step.result.reason}</span>
          </p>
          <div className="flex flex-wrap gap-2">
            {step.result.kind === "item" && (
              <button className="btn-primary btn-sm" onClick={() => void addItem()}>
                Add this item
              </button>
            )}
            {step.result.category && (
              <button
                className="btn-ghost btn-sm"
                onClick={async () => {
                  setStep({ kind: "busy", label: "Starting…" });
                  await startCrawl({ url: step.result.category!.url, runner: "browser" }).then((job) => setStep({ kind: "started", job, what: `Crawling ${step.result.category!.name}` }), fail);
                }}
              >
                Crawl “{step.result.category.name}”
              </button>
            )}
            <button className="btn-ghost btn-sm" onClick={() => void crawl(true)}>
              Crawl anyway
            </button>
          </div>
        </div>
      )}
      {step.kind === "pickCollection" && <PickCollection options={step.options} onPick={(id) => void confirmAdd(step.snapshot, id)} onCancel={() => setStep({ kind: "idle" })} />}
      {step.kind === "started" && (
        <p className="text-brand-800 dark:text-brand-100">
          {step.what} — job #{step.job.id}. Progress is below and in SpecHarvest.
        </p>
      )}
      {step.kind === "error" && (
        <div className="flex items-start justify-between gap-2">
          <p className="text-red-600">{step.message}</p>
          <button className="btn-ghost btn-sm" onClick={() => setStep({ kind: "idle" })}>
            Back
          </button>
        </div>
      )}
    </section>
  );
}

function PickCollection({ options, onPick, onCancel }: { options: Collection[]; onPick: (id: number | null) => void; onCancel: () => void }) {
  const [choice, setChoice] = useState<string>(options[0] ? String(options[0].id) : "new");
  return (
    <div className="flex flex-col gap-2">
      <label className="flex flex-col gap-1">
        Add to
        <select className="input h-9" value={choice} onChange={(e) => setChoice(e.target.value)}>
          {options.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name} ({c.itemCount})
            </option>
          ))}
          <option value="new">New collection</option>
        </select>
      </label>
      <div className="flex gap-2">
        <button className="btn-primary btn-sm" onClick={() => onPick(choice === "new" ? null : Number(choice))}>
          Add item
        </button>
        <button className="btn-ghost btn-sm" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/** The user's running crawls, refreshed while the popup is open. */
function Jobs({ serverUrl }: { serverUrl: string }) {
  const [jobs, setJobs] = useState<Job[] | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () =>
      listJobs().then(
        (all) => alive && setJobs(all.filter(isActiveJob)),
        () => alive && setJobs([]),
      );
    void load();
    const t = setInterval(load, 2000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);
  if (!jobs?.length) return null;
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-stone-500">Running</h2>
      {jobs.map((j) => (
        <div key={j.id} className="card flex flex-col gap-1.5 p-2.5 text-xs">
          <div className="flex items-center gap-2">
            <a className="font-medium underline-offset-2 hover:underline" href={serverUrl} target="_blank" rel="noreferrer">
              #{j.id} {j.kind === "crawl" ? "Crawl" : "Web lookup"}
              {j.runner === "browser" ? " · in this browser" : ""}
            </a>
            <button className="btn-ghost btn-sm ml-auto h-6 px-2" onClick={() => void stopJob(j.id).catch(() => {})}>
              Stop
            </button>
          </div>
          <div className="h-1.5 overflow-hidden rounded bg-stone-200 dark:bg-stone-800">
            <div className="h-full bg-brand-600 transition-all" style={{ width: `${j.itemsFound ? Math.round((100 * j.itemsIndexed) / j.itemsFound) : 5}%` }} />
          </div>
          <div className="truncate text-stone-500" title={j.message ?? ""}>
            {j.itemsIndexed}/{j.itemsFound || "?"} · {j.message}
          </div>
        </div>
      ))}
    </section>
  );
}
