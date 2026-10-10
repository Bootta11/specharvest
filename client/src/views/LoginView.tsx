import { useEffect, useState, type FormEvent } from "react";
import { api } from "../lib/api.ts";
import type { Auth } from "../lib/auth.ts";
import { Field, Notice } from "../components/Modal.tsx";
import { DEFAULT_SERVER, isNative, normalizeServerUrl, serverUrl, setServerUrl } from "../lib/platform.ts";

/** The Android app's server choice: specharvest.bootta.dev, or a custom (e.g. self-hosted) one. */
function ServerPicker({ onChanged }: { onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = serverUrl();

  const save = async (url: string) => {
    setBusy(true);
    setError(null);
    try {
      const origin = normalizeServerUrl(url);
      const res = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(10_000) });
      const health = (await res.json().catch(() => null)) as { ok?: boolean } | null;
      if (!res.ok || !health?.ok) throw new Error(`${origin} doesn't look like a SpecHarvest server`);
      setServerUrl(origin);
      setEditing(false);
      onChanged();
    } catch (err) {
      setError(err instanceof TypeError ? "Can't reach that server — check the address and your connection" : (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!editing) {
    return (
      <div className="card flex items-center gap-3 px-4 py-3 text-sm">
        <div className="min-w-0 flex-1">
          <div className="text-xs text-stone-500">Server</div>
          <div className="truncate font-medium">{current.replace(/^https:\/\//, "")}</div>
        </div>
        <button type="button" className="btn-ghost btn-sm" onClick={() => (setValue(current === DEFAULT_SERVER ? "" : current), setEditing(true))}>
          {current === DEFAULT_SERVER ? "Use a custom server…" : "Change"}
        </button>
      </div>
    );
  }
  return (
    <form
      className="card space-y-3 p-4"
      onSubmit={(e) => {
        e.preventDefault();
        void save(value);
      }}
    >
      {error && <Notice kind="error">{error}</Notice>}
      <Field label="Server address" hint="Your own SpecHarvest over HTTPS, e.g. specharvest.example.com">
        <input className="input" inputMode="url" autoCapitalize="none" autoCorrect="off" required autoFocus value={value} onChange={(e) => setValue(e.target.value)} />
      </Field>
      <div className="flex flex-wrap justify-end gap-2">
        {current !== DEFAULT_SERVER && (
          <button type="button" className="btn-ghost btn-sm mr-auto" disabled={busy} onClick={() => void save(DEFAULT_SERVER)}>
            Use specharvest.bootta.dev
          </button>
        )}
        <button type="button" className="btn-ghost btn-sm" onClick={() => setEditing(false)}>
          Cancel
        </button>
        <button className="btn-primary btn-sm" disabled={busy}>
          {busy ? "Checking…" : "Use this server"}
        </button>
      </div>
    </form>
  );
}

export function LoginView({ auth }: { auth: Auth }) {
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [signupEnabled, setSignupEnabled] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Bumped when the app switches servers, to re-read that server's sign-up setting.
  const [server, setServer] = useState(0);

  useEffect(() => {
    api.authStatus().then((s) => setSignupEnabled(s.signupEnabled), () => setSignupEnabled(false));
  }, [server]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === "login") await auth.login(email, password);
      else await auth.signup(email, password);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const signup = mode === "signup";

  return (
    <div className="grid min-h-dvh place-items-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center justify-center gap-2">
          <img src="/logo.png" alt="" className="size-10" />
          <span className="text-xl font-semibold tracking-tight">SpecHarvest</span>
        </div>
        {isNative && (
          <div className="mb-3">
            <ServerPicker onChanged={() => (setServer((n) => n + 1), setError(null))} />
          </div>
        )}
        <form onSubmit={submit} className="card space-y-4 p-5 sm:p-6">
          <h1 className="text-lg font-semibold">{signup ? "Create an account" : "Sign in"}</h1>
          {error && <Notice kind="error">{error}</Notice>}
          <Field label="Email">
            <input className="input" type="email" autoComplete="email" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <Field label="Password" hint={signup ? "At least 8 characters." : undefined}>
            <input
              className="input"
              type="password"
              autoComplete={signup ? "new-password" : "current-password"}
              required
              minLength={signup ? 8 : undefined}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
          <button className="btn-primary w-full" disabled={busy}>
            {busy ? "…" : signup ? "Create account" : "Sign in"}
          </button>
          {signupEnabled && (
            <p className="text-center text-sm text-stone-500">
              {signup ? "Already have an account? " : "No account yet? "}
              <button
                type="button"
                className="font-medium text-brand-700 hover:underline dark:text-brand-100"
                onClick={() => {
                  setMode(signup ? "login" : "signup");
                  setError(null);
                }}
              >
                {signup ? "Sign in" : "Create one"}
              </button>
            </p>
          )}
        </form>
        {!signupEnabled && <p className="mt-4 text-center text-xs text-stone-500">Accounts are created by an admin.</p>}
      </div>
    </div>
  );
}
