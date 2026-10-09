# LLM providers & API keys

Every LLM task runs on one of two kinds of key:

- **Your own key.** Each user can add API keys for any supported provider under
  *avatar menu → LLM provider*. You pay that provider directly.
- **The server's key.** The OpenRouter key in `OPENROUTER_API_KEY` is used for
  people without a suitable key of their own, if the admin allows it. Its models
  are the `OPENROUTER_*` settings.

Everything goes through the [Vercel AI SDK](https://ai-sdk.dev) 7 and its
official provider packages. See [Library](#library) for why.

## For users

1. Open *avatar menu → LLM provider*, pick a provider and paste your key.
2. *Save key*. The key is checked with one tiny request first. A rejected key is
   not stored. A key that works but has a problem (out of credit, the
   recommended model isn't on your account) is saved with a warning.
3. *What runs where* shows the provider and model each kind of task uses, and
   who pays (*your key* / *server key*). *Test* makes one tiny call.
4. Optional: under *Models*, pick a provider and model per kind of task.
   *Automatic* uses your first key (in catalog order) that can do the job, with
   that provider's recommended model.

| Kind of task | Used for | Server key model |
| --- | --- | --- |
| Fast | listing detection, spec extraction, search parsing, spec prediction — most of the volume | `OPENROUTER_MODEL`; extraction: `OPENROUTER_EXTRACTION_MODEL` |
| Smart | product grouping, key merging | `OPENROUTER_SMART_MODEL` |
| Web lookups | finding specs a listing doesn't state | `OPENROUTER_WEB_MODEL`, with `WEB_SEARCH_ENGINE` / `WEB_SEARCH_MAX_USES` |

How a provider is chosen, per kind of task (first match wins):

1. The model you picked, if you still have that provider's key. For web lookups
   the model must also be able to search the web.
2. Automatic: your first key that can do the task, with its recommended model.
3. The server's key, if the admin lets you use it.
4. Otherwise the task can't run. You see what to add: the crawl button is
   disabled, a banner offers *Set up LLM provider*, and search shows the reason.

If your key fails, the work is never retried on the server key.

## Providers

| Provider | Web lookups | Cost in the $ menu | Recommended fast / smart / web |
| --- | --- | --- | --- |
| OpenRouter | ✓ `openrouter:web_search` | exact | `google/gemini-2.5-flash-lite` / `google/gemini-2.5-flash` / smart |
| OpenAI | ✓ web search tool | estimated | `gpt-5-nano` / `gpt-5-mini` / `gpt-5-mini` |
| Anthropic | ✓ web search tool | estimated | `claude-haiku-4-5` / `claude-sonnet-5-5` / `claude-haiku-4-5` |
| Google Gemini | ✓ Google Search grounding | estimated | `gemini-flash-lite-latest` / `gemini-flash-latest` / smart |
| Mistral | ✓ web search (Conversations API) | estimated | `mistral-small-latest` / `mistral-medium-latest` / smart |
| xAI | ✓ web search | estimated | `grok-4.20-0309-non-reasoning` / `grok-4.3` / smart |
| Groq | ✓ browser search (gpt-oss models only) | estimated | `openai/gpt-oss-20b` / `openai/gpt-oss-120b` / smart |
| Perplexity | ✓ every call searches, so web lookups only | exact | — / — / `sonar` |
| DeepSeek, DeepInfra, Together AI, Fireworks, Cerebras | — | estimated | see `server/src/llm/providers.ts` |
| Custom (admins only) | — | unpriced | any OpenAI-compatible URL: Ollama, LM Studio, vLLM… |

**Custom endpoints are admin-only.** The server calls whatever URL is set, so a
regular user could otherwise point it at internal addresses (SSRF).

## For admins

*avatar menu → Users & sign-up → Server LLM key* chooses who may use the server
key when they have no key of their own: **Everyone** (default, as before
per-user keys existed), **Admins only**, or **Nobody**. People's own keys always
come first. Without `OPENROUTER_API_KEY` everyone needs a key of their own.

**Daily limit per user** (default **$1**, same place): what one regular user may
spend on the server key per day (since midnight, server time). Past it, their
work needs their own key until tomorrow. A running crawl stops as resumable,
and *Settings → LLM provider* says why and shows today's spend. Admins have no
limit, and their own keys are never limited. 0 turns the limit off.

## Keys at rest

- Keys are stored in `llm_keys`, encrypted with AES-256-GCM (`server/src/lib/secrets.ts`).
  Each ciphertext is bound to its user and provider, so a key copied onto another
  user's row won't decrypt.
- The master key is `ENCRYPTION_KEY` (32 bytes, base64 or hex:
  `openssl rand -base64 32`; `ENCRYPTION_KEY_FILE` works too). If it is blank,
  one is generated once into `DATA_DIR/encryption.key` (mode 600) and a warning
  is logged. That means anyone with the data volume has both the database and
  the key, so set `ENCRYPTION_KEY` in production and keep a copy outside the volume.
- **Losing or changing the master key** makes stored keys unreadable. They are
  flagged in Settings ("can't be decrypted — enter it again") and skipped until
  the user re-enters them.
- The API never returns a key, only its last 4 characters. Keys aren't logged,
  and exports don't include them.

## Cost

- **Exact:** OpenRouter and Perplexity report the price of every call,
  including web search fees.
- **Estimated:** for other providers, tokens (incl. cache reads/writes) × the
  model's price from [models.dev](https://models.dev) (MIT, refreshed daily and
  kept in `settings.llm-prices`), plus web searches × an approximate per-search
  fee from the catalog. Estimated rows have `llm_usage.cost_estimated = 1`, and
  the $ menu says "partly estimated".
- Unknown models (e.g. a custom endpoint) are counted as unpriced calls.
- Each `llm_usage` row records `provider` and `funding` (`own` = your key,
  `platform` = server key). The $ menu splits your spend that way.

## When a key stops working

A rejected key (401/403) or an account without credit (402, `insufficient_quota`)
stops the work instead of failing item by item:

- **Crawl:** ends *Stopped: Your OpenAI key was rejected — fix it in Settings → LLM provider*.
  It is resumable: fix the key, then *Resume*.
- **Web lookup:** fails with the same message and keeps the values found before.
- **Search:** answers `400` with the message.

The provider's error is saved on the key and shown in Settings until a call
with it works again.

## Adding a provider

Add one entry to `PROVIDERS` in `server/src/llm/providers.ts` with:

- the AI SDK factory,
- the models.dev provider id (prices, model suggestions),
- recommended models per tier,
- the web search tool, if any, and its per-search fee for estimates.

A host that speaks the OpenAI API (Hugging Face, Moonshot, Z.ai, Qwen,
Baseten, …) needs no new package: use `createOpenAICompatible` with its base URL.

## Library

[Vercel AI SDK 7](https://ai-sdk.dev) (`ai` + `@ai-sdk/*`, Apache-2.0):

- it runs in-process, with no proxy service;
- it creates a provider client per key;
- one `generateText` call covers every provider;
- token usage is normalized across providers;
- it supports each provider's native web search.

The OpenRouter provider (`@openrouter/ai-sdk-provider`) reports the exact cost
and runs OpenRouter's web search tool.

- **Library code stays in two files:** `client.ts` (transport, JSON pipeline,
  error classification) and `providers.ts` (catalog). The keyring, encryption,
  settings UI, ledger and admin policy don't depend on the library.
- **No model id strings.** Models are always built from a provider instance
  made with the key. The AI SDK sends a plain `"provider/model"` string through
  Vercel's AI Gateway, so `ProviderClient.model()` is typed to exclude strings.
- **JSON pipeline unchanged.** JSON mode is a middleware that only sets the
  provider's response format. The existing prompt → repair → salvage → zod →
  one retry pipeline still parses the answer, so cost and usage are recorded
  even when the JSON is broken.

Alternatives considered (October 2026):

- **TanStack AI** is pre-1.0 and has fewer providers with web search. Worth
  another look at 1.0.
- **Mastra** is built on the AI SDK and adds agent features this app doesn't need.
- **LiteLLM** is a Python proxy that needs Postgres.
- **OpenAI SDK + per-user base URL** gives no uniform web search or usage data.

## Roadmap: prepaid credits (not built yet)

The pieces are in place for selling credit packs to people without a key of
their own:

1. **Exact cost.** Server-key calls always go through OpenRouter, which reports
   the exact price.
2. **One choke point.** `recordUsage()` in `server/src/llm/usage.ts` is the
   single place every cost passes through, with `funding` set. Debit
   `cost × (1 + CREDIT_MARKUP)` there for `platform` calls.
3. **Ledger.** Add an append-only `credit_ledger (user_id, amount_micros INTEGER,
   kind: purchase|usage|grant|refund|adjust, ref UNIQUE, created_at)`. Integer
   micro-USD avoids float drift. A unique `ref` (payment transaction / usage row)
   makes webhooks idempotent.
4. **Resolver.** Rule 3 becomes "server key while the user has credit". Jobs
   check the balance before starting. At zero they stop the way a rejected key
   does (stopped, resumable after a top-up).
5. **Payments.** Paddle Billing (Merchant of Record, so VAT and sales tax are
   handled) with one-time "credit pack" prices; its `transaction.completed`
   webhook adds a `purchase` row. Alternatives: Stripe token billing (preview
   since March 2026), Polar.
6. **Safety net.** Give each paying user an OpenRouter provisioning key with
   `limit` = credit bought, so OpenRouter itself caps spend.
7. **Margin.** The markup must cover OpenRouter's 5.5% credit-purchase fee and
   payment fees.
