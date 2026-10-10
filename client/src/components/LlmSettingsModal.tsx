import { useEffect, useMemo, useState, type FormEvent } from "react";
import { llmTiers, type LlmModelChoices, type LlmModelList, type LlmModelOption, type LlmProviderInfo, type LlmSettingsResponse, type LlmTestResult, type LlmTier } from "@specharvest/shared";
import { api, formatUsd } from "../lib/api.ts";
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
        {server.configured && server.allowed && server.dailyLimitUsd > 0 && (
          <> Today you've used {formatUsd(server.spentTodayUsd)} of your {formatUsd(server.dailyLimitUsd)} a day on it.</>
        )}
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

/** "$0.05 / $0.40" per 1M tokens, for the dropdown options. */
function shortPrice(m: LlmModelOption): string {
  if (m.input === null || m.output === null) return "";
  const f = (n: number) => `$${n < 0.1 ? +n.toFixed(3) : +n.toFixed(2)}`;
  return ` — ${f(m.input)} / ${f(m.output)}`;
}

const OTHER = "__other__";

function Models({ settings, onSaved }: { settings: LlmSettingsResponse; onSaved: (s: LlmSettingsResponse) => void }) {
  const [choices, setChoices] = useState<LlmModelChoices>(settings.models);
  // Model lists per provider + tier (web lists only models that can search); "loading" while fetching.
  const [lists, setLists] = useState<Record<string, LlmModelList | "loading">>({});
  // Tiers where the user chose "Other model id…" and types it.
  const [typing, setTyping] = useState<Partial<Record<LlmTier, boolean>>>({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const label = useLabels(settings.providers);

  // Server-side changes (a removed key clears its picks) win over the draft.
  useEffect(() => setChoices(settings.models), [settings.models]);
  // A changed key may change what its account can use.
  useEffect(() => setLists({}), [settings.keys]);

  const connected = settings.providers.filter((p) => settings.keys.some((k) => k.provider === p.id));
  const usable = (tier: LlmTier) => connected.filter((p) => p.tiers.includes(tier) && (tier !== "web" || p.webSearch));
  const listKey = (provider: string, tier: LlmTier) => `${provider}:${tier}`;

  useEffect(() => {
    for (const tier of llmTiers) {
      const id = choices[tier]?.provider;
      if (!id || lists[listKey(id, tier)]) continue;
      setLists((l) => ({ ...l, [listKey(id, tier)]: "loading" }));
      api.llmModelOptions(id, tier).then(
        (list) => setLists((l) => ({ ...l, [listKey(id, tier)]: list })),
        () => setLists((l) => ({ ...l, [listKey(id, tier)]: { source: "models.dev", models: [] } })),
      );
    }
  }, [choices, lists]);

  const dirty = JSON.stringify(choices) !== JSON.stringify(settings.models);

  const pickProvider = (tier: LlmTier, id: string) => {
    const p = settings.providers.find((x) => x.id === id);
    setChoices((c) => ({ ...c, [tier]: p ? { provider: p.id, model: p.defaults[tier] ?? "" } : null }));
    setTyping((t) => ({ ...t, [tier]: false }));
    setMsg(null);
  };
  const setModel = (tier: LlmTier, model: string) => setChoices((c) => ({ ...c, [tier]: c[tier] ? { ...c[tier]!, model } : null }));

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
          const auto = settings.effective[tier];
          const entry = pick ? lists[listKey(pick.provider, tier)] : undefined;
          const loading = entry === "loading" || (!!pick && entry === undefined);
          const list = entry && entry !== "loading" ? entry : null;
          const models = list?.models ?? [];
          const current = pick ? models.find((m) => m.id === pick.model) : undefined;
          // A saved or default model the list doesn't contain stays selectable, so it's never silently lost.
          const options = pick?.model && !current ? [{ id: pick.model, name: pick.model, input: null, output: null }, ...models] : models;
          const free = !!pick && (typing[tier] || (!!list && models.length === 0));
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
                {!pick ? (
                  <input className="input font-mono text-xs" aria-label={`${TIERS[tier].title} model`} disabled value={auto?.model ?? ""} />
                ) : free ? (
                  <input
                    className="input font-mono text-xs"
                    aria-label={`${TIERS[tier].title} model id`}
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    value={pick.model}
                    placeholder="exact model id"
                    onChange={(e) => setModel(tier, e.target.value)}
                  />
                ) : (
                  <select
                    className="input"
                    aria-label={`${TIERS[tier].title} model`}
                    disabled={loading}
                    value={pick.model}
                    onChange={(e) => (e.target.value === OTHER ? setTyping((t) => ({ ...t, [tier]: true })) : setModel(tier, e.target.value))}
                  >
                    {loading ? (
                      <option>Loading models…</option>
                    ) : (
                      <>
                        {!pick.model && <option value="">Choose a model…</option>}
                        {options.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.name}
                            {shortPrice(m)}
                          </option>
                        ))}
                        <option value={OTHER}>Other model id…</option>
                      </>
                    )}
                  </select>
                )}
                <div className="mt-1 flex flex-wrap gap-x-2 text-xs text-stone-500">
                  {!pick ? (
                    auto && (
                      <span>
                        {label(auto.provider)} · {auto.funding === "own" ? "your key" : "server key"}
                      </span>
                    )
                  ) : (
                    <>
                      {pick.model && <span className="truncate font-mono">{pick.model}</span>}
                      {priceLabel(current) && <span>{priceLabel(current)}</span>}
                      {list?.source === "models.dev" && !free && <span>from the public price list</span>}
                      {typing[tier] && models.length > 0 && (
                        <button type="button" className="text-brand-700 underline dark:text-brand-100" onClick={() => setTyping((t) => ({ ...t, [tier]: false }))}>
                          Back to list
                        </button>
                      )}
                    </>
                  )}
                </div>
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
