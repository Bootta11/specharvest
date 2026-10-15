import type { LlmPurpose, UsageSummary } from "@specharvest/shared";
import { formatUsd } from "../lib/api.ts";

const PURPOSE_LABEL: Record<LlmPurpose, string> = {
  extract: "Spec extraction",
  detect: "Listing detection",
  consolidate: "Key merging",
  search: "Search parsing",
  "web-lookup": "Web lookups",
  group: "Product grouping",
  predict: "Spec prediction",
};

const calls = (n: number) => `${n} call${n === 1 ? "" : "s"}`;
const fmtTokens = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));

/** LLM spend: today / 30 days / all time, then by task and by model (the spend menu, and everyone's in the admin dashboard). */
export function SpendBreakdown({ usage, ownKeysLabel = "Your keys" }: { usage: UsageSummary; ownKeysLabel?: string }) {
  return (
    <>
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

      {usage.byFunding.own > 0 && (
        <p className="mt-2 text-xs text-stone-500 tabular-nums">
          {ownKeysLabel}: <span className="font-medium text-stone-700 dark:text-stone-200">{formatUsd(usage.byFunding.own)}</span>
          {usage.estimated > 0 && " (partly estimated)"} · Server key: <span className="font-medium text-stone-700 dark:text-stone-200">{formatUsd(usage.byFunding.platform)}</span>
        </p>
      )}

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
                <tr key={`${m.provider}/${m.model}`} className="border-t border-stone-100 dark:border-stone-800">
                  <td className="truncate py-1.5" title={`${m.provider}: ${m.model}`}>
                    {m.model}
                    <div className="text-xs text-stone-500 tabular-nums">
                      {m.provider} · {calls(m.calls)} · {fmtTokens(m.promptTokens)} in / {fmtTokens(m.completionTokens)} out
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
    </>
  );
}
