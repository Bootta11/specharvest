import { useEffect, useState } from "react";
import type { ProviderCredits, UsageSummary } from "@specharvest/shared";
import { formatUsd } from "../lib/api.ts";
import { Notice } from "../components/Modal.tsx";
import { SpendBreakdown } from "../components/SpendBreakdown.tsx";
import { adminApi } from "./api.ts";

/** OpenRouter balance: whole account (with a management key) and the server's API key. */
function CreditsBlock({ credits }: { credits: ProviderCredits | null }) {
  if (!credits) return <p className="text-sm text-stone-500">Loading OpenRouter credits…</p>;
  const { account, key, errors } = credits;
  return (
    <>
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
    </>
  );
}

/** Everyone's LLM spend and the server key's OpenRouter balance. */
export function UsagePage() {
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const [credits, setCredits] = useState<ProviderCredits | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fail = (err: unknown) => setError((err as Error).message);
    adminApi.usage().then(setUsage, fail);
    adminApi.credits().then(setCredits, fail);
  }, []);

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_2fr] lg:items-start">
      {error && (
        <div className="lg:col-span-2">
          <Notice kind="error">{error}</Notice>
        </div>
      )}
      <section className="card p-4 text-sm sm:p-6" aria-label="OpenRouter credits">
        <h2 className="text-base font-semibold">OpenRouter credits</h2>
        <CreditsBlock credits={credits} />
      </section>
      <section className="card p-4 text-sm sm:p-6" aria-label="LLM spend, all users">
        <h2 className="text-base font-semibold">LLM spend — all users</h2>
        {usage ? <SpendBreakdown usage={usage} ownKeysLabel="Users' own keys" /> : <p className="mt-3 text-stone-500">Loading…</p>}
      </section>
    </div>
  );
}
