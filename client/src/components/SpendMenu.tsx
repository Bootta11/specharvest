import { useCallback, useEffect, useRef, useState } from "react";
import type { LlmPurpose, ProviderCredits, UsageSummary } from "@specharvest/shared";
import { api, formatUsd } from "../lib/api.ts";

const PURPOSE_LABEL: Record<LlmPurpose, string> = {
  extract: "Spec extraction",
  detect: "Listing detection",
  consolidate: "Key merging",
  search: "Search parsing",
  "web-lookup": "Web lookups",
  group: "Product grouping",
  predict: "Spec prediction",
};

const REFRESH_MS = 20_000;

const calls = (n: number) => `${n} call${n === 1 ? "" : "s"}`;
const fmtTokens = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));

/** OpenRouter balance: whole account (with a management key) and the server's API key. */
function CreditsBlock({ credits }: { credits: ProviderCredits | null }) {
  if (!credits) return <p className="text-xs text-stone-500">Loading OpenRouter credits…</p>;
  const { account, key, errors } = credits;
  return (
    <section aria-label="OpenRouter credits" className="mb-4 rounded-md bg-stone-50 p-3 dark:bg-stone-800/60">
      <h3 className="text-xs font-medium uppercase tracking-wide text-stone-500">OpenRouter credits</h3>
      {account && (
        <div className="mt-1">
          <span className="text-lg font-semibold tabular-nums">{formatUsd(account.remaining)}</span>
          <span className="ml-1.5 text-xs text-stone-500">left of {formatUsd(account.totalCredits)} purchased</span>
        </div>
      )}
      {key && (
        <div className="mt-1 text-xs text-stone-600 tabular-nums dark:text-stone-300">
          {key.limit === null ? (
            <>API key: uncapped</>
          ) : (
            <>
              API key: <span className="font-medium">{formatUsd(key.remaining ?? 0)}</span> left of {formatUsd(key.limit)}
            </>
          )}
          {" · "}
          {formatUsd(key.usageDaily)} today · {formatUsd(key.usageMonthly)} this month
          {key.freeTier && " · free tier"}
        </div>
      )}
      {errors.map((e) => (
        <p key={e} className="mt-1 text-xs text-stone-500">
          {e}
        </p>
      ))}
    </section>
  );
}

/** Header pill with your all-time LLM spend; opens a today / 30 days / all-time breakdown (admins can switch to everyone's). */
export function SpendMenu({ isAdmin = false }: { isAdmin?: boolean }) {
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const [open, setOpen] = useState(false);
  const [everyone, setEveryone] = useState(false);
  const [credits, setCredits] = useState<ProviderCredits | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(() => {
    api.usage(everyone).then(setUsage, () => {});
  }, [everyone]);

  useEffect(() => {
    refresh();
    const t = setInterval(() => document.visibilityState === "visible" && refresh(), REFRESH_MS);
    return () => clearInterval(t);
  }, [refresh]);

  useEffect(() => {
    if (!open) return;
    refresh();
    if (isAdmin) api.credits().then(setCredits, () => {});
    const onDown = (e: PointerEvent) => !rootRef.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, refresh, isAdmin]);

  if (!usage) return null;

  return (
    <div ref={rootRef} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="rounded-full border border-stone-200 px-2.5 py-1 text-xs font-medium tabular-nums text-stone-600 hover:border-brand-600 hover:text-brand-800 dark:border-stone-700 dark:text-stone-300 dark:hover:text-brand-100"
        title={everyone ? "LLM spend, all users (all time)" : "Your LLM spend (all time)"}
        aria-expanded={open}
        aria-haspopup="dialog"
      >
        {formatUsd(usage.allTime)}
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="LLM spend"
          className="card fixed inset-x-4 top-16 z-30 max-h-[calc(100dvh-5rem)] overflow-y-auto p-4 text-sm shadow-lg sm:absolute sm:inset-x-auto sm:right-0 sm:top-full sm:mt-2 sm:w-96"
        >
          {isAdmin && <CreditsBlock credits={credits} />}
          <div className="flex items-center gap-2">
            <h2 className="mr-auto font-medium">{everyone ? "LLM spend — all users" : "Your LLM spend"}</h2>
            {isAdmin && (
              <div className="flex rounded-md bg-stone-100 p-0.5 text-xs dark:bg-stone-800" role="group" aria-label="Whose spend">
                {([false, true] as const).map((all) => (
                  <button
                    key={String(all)}
                    onClick={() => setEveryone(all)}
                    className={`rounded px-2 py-0.5 font-medium ${everyone === all ? "bg-white shadow-sm dark:bg-stone-900" : "text-stone-500"}`}
                    aria-pressed={everyone === all}
                  >
                    {all ? "Everyone" : "Mine"}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="mt-3 grid grid-cols-3 gap-3">
            {(
              [
                ["today", usage.today],
                ["30 days", usage.last30d],
                ["all time", usage.allTime],
              ] as const
            ).map(([label, v]) => (
              <div key={label}>
                <div className="text-lg font-semibold tabular-nums">{formatUsd(v)}</div>
                <div className="text-xs text-stone-500">{label}</div>
              </div>
            ))}
          </div>

          {usage.byPurpose.length === 0 ? (
            <p className="mt-4 text-stone-500">No LLM calls yet.</p>
          ) : (
            <>
              <h3 className="mt-4 text-xs font-medium uppercase tracking-wide text-stone-500">By task</h3>
              <table className="mt-1 w-full">
                <tbody>
                  {usage.byPurpose.map((p) => (
                    <tr key={p.purpose} className="border-t border-stone-100 dark:border-stone-800">
                      <td className="py-1.5">{PURPOSE_LABEL[p.purpose] ?? p.purpose}</td>
                      <td className="py-1.5 text-right text-xs text-stone-500 tabular-nums">{calls(p.calls)}</td>
                      <td className="w-20 py-1.5 text-right tabular-nums">{formatUsd(p.cost)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>

              <h3 className="mt-4 text-xs font-medium uppercase tracking-wide text-stone-500">By model</h3>
              <table className="mt-1 w-full table-fixed">
                <tbody>
                  {usage.byModel.map((m) => (
                    <tr key={m.model} className="border-t border-stone-100 dark:border-stone-800">
                      <td className="truncate py-1.5" title={m.model}>
                        {m.model}
                        <div className="text-xs text-stone-500 tabular-nums">
                          {calls(m.calls)} · {fmtTokens(m.promptTokens)} in / {fmtTokens(m.completionTokens)} out
                        </div>
                      </td>
                      <td className="w-20 py-1.5 text-right align-top tabular-nums">{formatUsd(m.cost)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
          {usage.unpricedCalls > 0 && <p className="mt-3 text-xs text-stone-500">{usage.unpricedCalls} calls had no price in the response and count as $0.</p>}
        </div>
      )}
    </div>
  );
}
