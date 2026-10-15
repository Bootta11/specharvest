import { useEffect, useState } from "react";
import type { AdminSettings, ServerLlmAccess } from "@specharvest/shared";
import { Notice } from "../components/Modal.tsx";
import { adminApi } from "./api.ts";

/** Sign-up, and who may use the server's LLM key (and how much a day). */
export function SettingsPage() {
  const [settings, setSettings] = useState<AdminSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** The daily limit as typed, saved on blur/Enter. */
  const [limitDraft, setLimitDraft] = useState("");

  const fail = (err: unknown) => setError((err as Error).message);
  useEffect(() => {
    adminApi.settings().then(setSettings, fail);
  }, []);

  const saveSettings = async (patch: Parameters<typeof adminApi.saveSettings>[0]) => {
    setError(null);
    try {
      setSettings(await adminApi.saveSettings(patch));
    } catch (err) {
      fail(err);
    }
  };

  const savedLimit = settings?.serverLlmDailyLimitUsd;
  useEffect(() => {
    if (savedLimit !== undefined) setLimitDraft(String(savedLimit));
  }, [savedLimit]);

  const commitLimit = () => {
    if (savedLimit === undefined) return;
    const usd = Number(limitDraft);
    if (limitDraft.trim() === "" || !Number.isFinite(usd) || usd < 0 || usd > 1000) return setLimitDraft(String(savedLimit));
    if (usd !== savedLimit) saveSettings({ serverLlmDailyLimitUsd: usd });
  };

  return (
    <div className="space-y-6">
      {error && <Notice kind="error">{error}</Notice>}

      <section className="card p-4 sm:p-6">
        <h2 className="mb-1 text-base font-semibold">Sign-up</h2>
        <label className="flex cursor-pointer items-start gap-3 py-1.5">
          <input
            type="checkbox"
            className="mt-0.5 size-4 shrink-0 accent-brand-700"
            disabled={settings === null}
            checked={!!settings?.signupEnabled}
            onChange={(e) => saveSettings({ signupEnabled: e.target.checked })}
          />
          <span className="min-w-0">
            <span className="block text-sm font-medium">Anyone can create an account</span>
            <span className="block text-xs text-stone-500">Shows "Create one" on the sign-in page. New accounts are regular users.</span>
          </span>
        </label>
      </section>

      <section className="card space-y-3 p-4 sm:p-6">
        <div>
          <h2 className="text-base font-semibold">Server LLM key</h2>
          <p className="text-xs text-stone-500">
            {settings === null
              ? "Loading…"
              : settings.serverLlmConfigured
                ? "The server's OpenRouter key (OPENROUTER_API_KEY) runs work for people without a key of their own. Their own keys always come first."
                : "OPENROUTER_API_KEY is not set — everyone needs their own key (avatar menu → LLM provider)."}
          </p>
        </div>
        {settings?.serverLlmConfigured && (
          <label className="block max-w-xs">
            <span className="mb-1 block text-xs font-medium text-stone-600 dark:text-stone-400">Who may use it</span>
            <select className="input" value={settings.serverLlmAccess} onChange={(e) => saveSettings({ serverLlmAccess: e.target.value as ServerLlmAccess })}>
              <option value="everyone">Everyone</option>
              <option value="admins">Admins only</option>
              <option value="nobody">Nobody — everyone brings a key</option>
            </select>
          </label>
        )}
        {settings?.serverLlmConfigured && settings.serverLlmAccess === "everyone" && (
          <label className="block max-w-xs">
            <span className="mb-1 block text-xs font-medium text-stone-600 dark:text-stone-400">Daily limit per user (USD)</span>
            <input
              className="input"
              type="number"
              inputMode="decimal"
              min={0}
              max={1000}
              step="any"
              value={limitDraft}
              onChange={(e) => setLimitDraft(e.target.value)}
              onBlur={commitLimit}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commitLimit();
                }
              }}
            />
            <span className="mt-1 block text-xs text-stone-500">
              What one user may spend on the server key per day; their crawls pause (resumable) when it's used up. Admins have no limit. 0 = no limit.
            </span>
          </label>
        )}
      </section>
    </div>
  );
}
