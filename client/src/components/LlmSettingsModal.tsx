import { useEffect, useMemo, useState, type FormEvent } from "react";
import { llmTiers, type LlmModelChoices, type LlmModelOption, type LlmProviderInfo, type LlmSettingsResponse, type LlmTestResult, type LlmTier } from "@specharvest/shared";
import { api } from "../lib/api.ts";
import { Field, Modal, Notice } from "./Modal.tsx";

const TIERS: Record<LlmTier, { title: string; hint: string }> = {
  fast: { title: "Fast tasks", hint: "Spec extraction, listing detection, search parsing — most of the volume." },
  smart: { title: "Smart tasks", hint: "Product grouping and key merging — fewer calls, needs better judgement." },
  web: { title: "Web lookups", hint: "Finds specs listings don't state; needs a provider with web search." },
};

const date = (ts: number | null) => (ts ? new Date(ts).toLocaleDateString() : "—");

/** The server's reasons point at this page; here they point at the form below instead. */
const here = (reason: string | undefined) => reason?.replace(/ in Settings → LLM provider\.$/, " below.");

/** USD per 1M tokens, e.g. "$0.05 / $0.40 per 1M tokens". */
function priceLabel(m: LlmModelOption | undefined): string | null {
  if (!m || m.input === null || m.output === null) return null;
  const f = (n: number) => `$${n < 0.1 ? +n.toFixed(3) : +n.toFixed(2)}`;
  return `${f(m.input)} in / ${f(m.output)} out per 1M tokens`;
}

function FundingBadge({ funding }: { funding: "own" | "platform" }) {
  return funding === "own" ? (
    <span className="rounded-full bg-brand-50 px-2 py-0.5 text-xs font-medium text-brand-800 dark:bg-brand-900/40 dark:text-brand-100">your key</span>
  ) : (
    <span className="rounded-full bg-stone-100 px-2 py-0.5 text-xs font-medium text-stone-600 dark:bg-stone-800 dark:text-stone-300">server key</span>
  );
}

/** Each user's own LLM API keys and model picks (Settings → LLM provider). */
export function LlmSettingsModal({ onClose, onChanged }: { onClose: () => void; onChanged: () => void }) {
  const [settings, setSettings] = useState<LlmSettingsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.llmSettings().then(setSettings, (err) => setError((err as Error).message));
  }, []);

  const apply = (s: LlmSettingsResponse) => {
    setSettings(s);
    onChanged();
  };

  return (
    <Modal title="LLM provider" onClose={onClose} wide>
      {error && <Notice kind="error">{error}</Notice>}
      {!settings ? (
        !error && <p className="text-sm text-stone-500">Loading…</p>
      ) : (
        <>
          <Status settings={settings} />
          <Keys settings={settings} onSaved={apply} />
          <Models settings={settings} onSaved={apply} />
          <p className="text-xs text-stone-500">
            Keys are stored encrypted and only used for your own crawls, searches and lookups. Spend on your keys is shown in the $ menu — estimated from public price lists, exact for
            OpenRouter and Perplexity.
          </p>
        </>
      )}
    </Modal>
  );
}

function Status({ settings }: { settings: LlmSettingsResponse }) {
  const [tests, setTests] = useState<Partial<Record<LlmTier, LlmTestResult | "busy">>>({});
  const label = useLabels(settings.providers);

  const test = async (tier: LlmTier) => {
    setTests((t) => ({ ...t, [tier]: "busy" }));
    const r = await api.testLlm(tier).catch((err: unknown): LlmTestResult => ({ ok: false, error: (err as Error).message }));
    setTests((t) => ({ ...t, [tier]: r }));
  };

  const server = settings.server;
  return (
    <section className="space-y-2">
      <h3 className="text-sm font-semibold">What runs where</h3>
      <ul className="divide-y divide-stone-200 rounded-lg border border-stone-200 text-sm dark:divide-stone-800 dark:border-stone-800">
        {llmTiers.map((tier) => {
          const eff = settings.effective[tier];
          const t = tests[tier];
          return (
            <li key={tier} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5">
              <div className="min-w-0 flex-1 basis-48">
                <div className="font-medium">{TIERS[tier].title}</div>
                {eff ? (
                  <div className="truncate text-xs text-stone-500" title={`${label(eff.provider)} · ${eff.model}`}>
                    {label(eff.provider)} · {eff.model}
                  </div>
                ) : (
                  <div className="text-xs text-amber-700 dark:text-amber-300">{here(settings.unavailable[tier])}</div>
                )}
              </div>
              {eff && <FundingBadge funding={eff.funding} />}
              {eff && (
                <button className="btn-ghost btn-sm" disabled={t === "busy"} onClick={() => test(tier)}>
                  {t === "busy" ? "Testing…" : "Test"}
                </button>
              )}
              {t && t !== "busy" && (
                <div className={`w-full text-xs ${t.ok ? "text-emerald-700 dark:text-emerald-300" : "break-words text-red-700 dark:text-red-300"}`}>
                  {t.ok ? `Works ✓ (${t.ms} ms)` : t.error}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      <p className="text-xs text-stone-500">
        {!server.configured
          ? "There is no server key — every task needs a key of yours."
          : server.allowed
            ? "Tasks none of your keys can run use the server's key (OpenRouter)."
            : settings.keys.length
              ? "Only your own keys are used — the server's key isn't available to you."
              : "The server's key isn't available to you — add a key of your own."}
      </p>
    </section>
  );
}

function useLabels(providers: LlmProviderInfo[]) {
  return useMemo(() => {
    const byId = new Map(providers.map((p) => [p.id, p.label]));
    return (id: string) => byId.get(id) ?? id;
  }, [providers]);
}

const GROUPS: Array<{ id: LlmProviderInfo["group"]; label: string }> = [
  { id: "popular", label: "Popular" },
  { id: "more", label: "More providers" },
  { id: "custom", label: "Admins only" },
];

function Keys({ settings, onSaved }: { settings: LlmSettingsResponse; onSaved: (s: LlmSettingsResponse) => void }) {
  const [provider, setProvider] = useState(settings.providers[0]?.id ?? "");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const label = useLabels(settings.providers);
  const info = settings.providers.find((p) => p.id === provider);
  const replacing = settings.keys.some((k) => k.provider === provider);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      const s = await api.saveLlmKey(provider, apiKey.trim(), info?.custom ? baseUrl.trim() : undefined);
      const saved = s.keys.find((k) => k.provider === provider);
      setApiKey("");
      setMsg(saved?.lastError ? { kind: "error", text: `Saved, but: ${saved.lastError}` } : { kind: "ok", text: `${label(provider)} key saved and checked.` });
      onSaved(s);
    } catch (err) {
      setMsg({ kind: "error", text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    if (!window.confirm(`Remove your ${label(id)} key? Tasks using it switch to another key${settings.server.allowed ? " or the server's key" : ""}.`)) return;
    setMsg(null);
    try {
      onSaved(await api.deleteLlmKey(id));
    } catch (err) {
      setMsg({ kind: "error", text: (err as Error).message });
    }
  };

  return (
    <section className="space-y-3">
      <div>
        <h3 className="text-sm font-semibold">Your API keys</h3>
        <p className="text-xs text-stone-500">Use your own account with any of these providers. You pay them directly.</p>
      </div>

      {settings.keys.length > 0 && (
        <ul className="divide-y divide-stone-200 rounded-lg border border-stone-200 text-sm dark:divide-stone-800 dark:border-stone-800">
          {settings.keys.map((k) => (
            <li key={k.provider} className="flex items-center gap-3 px-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">
                  {label(k.provider)} <code className="ml-1 text-xs font-normal text-stone-500">{k.keyHint ? `…${k.keyHint}` : "(no key)"}</code>
                </div>
                <div className="truncate text-xs text-stone-500" title={k.baseUrl ?? undefined}>
                  {k.baseUrl ? `${k.baseUrl} · ` : ""}saved {date(k.createdAt)}
                </div>
                {k.lastError && <div className="break-words text-xs text-red-700 dark:text-red-300">{k.lastError}</div>}
              </div>
              <button className="btn-ghost btn-sm text-red-700 dark:text-red-300" onClick={() => remove(k.provider)}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}

      {msg && <Notice kind={msg.kind}>{msg.text}</Notice>}

      <form onSubmit={save} className="space-y-3 rounded-lg border border-dashed border-stone-300 p-3 dark:border-stone-700">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label="Provider"
            hint={
              info && (
                <>
                  {info.webSearch ? "Can run web lookups." : "No web search — lookups need another provider."}
                  {info.keyUrl && (
                    <>
                      {" "}
                      <a className="text-brand-700 underline dark:text-brand-100" href={info.keyUrl} target="_blank" rel="noreferrer">
                        Get a key ↗
                      </a>
                    </>
                  )}
                </>
              )
            }
          >
            <select className="input" value={provider} onChange={(e) => setProvider(e.target.value)}>
              {GROUPS.map((g) => {
                const list = settings.providers.filter((p) => p.group === g.id);
                return list.length === 0 ? null : (
                  <optgroup key={g.id} label={g.label}>
                    {list.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.label}
                        {settings.keys.some((k) => k.provider === p.id) ? " (saved)" : ""}
                      </option>
                    ))}
                  </optgroup>
                );
              })}
            </select>
          </Field>
          <Field label={replacing ? "New API key (replaces the saved one)" : "API key"}>
            <input
              className="input font-mono"
              type="password"
              autoComplete="off"
              spellCheck={false}
              required={!info?.custom}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={info?.custom ? "optional" : "sk-…"}
            />
          </Field>
          {info?.custom && (
            <div className="sm:col-span-2">
              <Field label="Base URL" hint="An OpenAI-compatible endpoint, e.g. Ollama http://localhost:11434/v1 or LM Studio http://localhost:1234/v1">
                <input className="input" type="url" required value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="http://localhost:11434/v1" />
              </Field>
            </div>
          )}
        </div>
        <div className="flex flex-wrap items-center justify-end gap-3">
          <span className="mr-auto text-xs text-stone-500">Checked with one tiny request before it's saved.</span>
          <button className="btn-primary" disabled={busy || (!info?.custom && apiKey.trim().length === 0)}>
            {busy ? "Checking…" : replacing ? "Replace key" : "Save key"}
          </button>
        </div>
      </form>
    </section>
  );
}

function Models({ settings, onSaved }: { settings: LlmSettingsResponse; onSaved: (s: LlmSettingsResponse) => void }) {
  const [choices, setChoices] = useState<LlmModelChoices>(settings.models);
  const [options, setOptions] = useState<Record<string, LlmModelOption[]>>({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const label = useLabels(settings.providers);

  // Server-side changes (a removed key clears its picks) win over the draft.
  useEffect(() => setChoices(settings.models), [settings.models]);

  const connected = settings.providers.filter((p) => settings.keys.some((k) => k.provider === p.id));
  const usable = (tier: LlmTier) => connected.filter((p) => p.tiers.includes(tier) && (tier !== "web" || p.webSearch));

  // Model suggestions (with prices) for every provider in use.
  useEffect(() => {
    for (const tier of llmTiers) {
      const id = choices[tier]?.provider;
      if (id && !options[id]) {
        setOptions((o) => ({ ...o, [id]: [] }));
        api.llmModelOptions(id).then((list) => setOptions((o) => ({ ...o, [id]: list })), () => {});
      }
    }
  }, [choices, options]);

  const dirty = JSON.stringify(choices) !== JSON.stringify(settings.models);

  const pickProvider = (tier: LlmTier, id: string) => {
    const p = settings.providers.find((x) => x.id === id);
    setChoices((c) => ({ ...c, [tier]: p ? { provider: p.id, model: p.defaults[tier] ?? "" } : null }));
    setMsg(null);
  };

  const save = async () => {
    setBusy(true);
    setMsg(null);
    try {
      onSaved(await api.saveLlmModels(choices));
      setMsg({ kind: "ok", text: "Models saved." });
    } catch (err) {
      setMsg({ kind: "error", text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  if (connected.length === 0) {
    return (
      <section>
        <h3 className="text-sm font-semibold">Models</h3>
        <p className="text-xs text-stone-500">Add a key above to pick which models run each kind of task.</p>
      </section>
    );
  }

  return (
    <section className="space-y-3">
      <div>
        <h3 className="text-sm font-semibold">Models</h3>
        <p className="text-xs text-stone-500">Automatic uses your first key that can do the job, with its recommended model.</p>
      </div>
      {msg && <Notice kind={msg.kind}>{msg.text}</Notice>}
      <div className="space-y-4">
        {llmTiers.map((tier) => {
          const pick = choices[tier];
          const list = pick ? (options[pick.provider] ?? []) : [];
          const price = pick ? priceLabel(list.find((m) => m.id === pick.model)) : null;
          const auto = settings.effective[tier];
          return (
            <div key={tier} className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.4fr)] sm:items-start">
              <div className="min-w-0">
                <div className="text-sm font-medium">{TIERS[tier].title}</div>
                <div className="text-xs text-stone-500">{TIERS[tier].hint}</div>
              </div>
              <select className="input" aria-label={`${TIERS[tier].title} provider`} value={pick?.provider ?? ""} onChange={(e) => pickProvider(tier, e.target.value)}>
                <option value="">Automatic</option>
                {usable(tier).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
              <div className="min-w-0">
                <input
                  className="input font-mono text-xs"
                  aria-label={`${TIERS[tier].title} model`}
                  list={`llm-models-${tier}`}
                  disabled={!pick}
                  value={pick?.model ?? (auto ? auto.model : "")}
                  placeholder="model id"
                  onChange={(e) => setChoices((c) => ({ ...c, [tier]: pick ? { ...pick, model: e.target.value } : null }))}
                />
                <datalist id={`llm-models-${tier}`}>
                  {list.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                      {priceLabel(m) ? ` — ${priceLabel(m)}` : ""}
                    </option>
                  ))}
                </datalist>
                {pick ? price && <div className="mt-1 text-xs text-stone-500">{price}</div> : auto && <div className="mt-1 text-xs text-stone-500">{label(auto.provider)} · {auto.funding === "own" ? "your key" : "server key"}</div>}
              </div>
            </div>
          );
        })}
      </div>
      <div className="flex justify-end">
        <button className="btn-primary" disabled={!dirty || busy || llmTiers.some((t) => choices[t] && !choices[t]!.model.trim())} onClick={save}>
          {busy ? "Saving…" : "Save models"}
        </button>
      </div>
    </section>
  );
}
