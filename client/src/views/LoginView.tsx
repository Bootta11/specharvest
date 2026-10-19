import { useEffect, useState, type FormEvent } from "react";
import { api } from "../lib/api.ts";
import type { Auth } from "../lib/auth.ts";
import { Field, Notice } from "../components/Modal.tsx";
import { AccountRow, host } from "../components/AccountRow.tsx";
import { LeaveServerButtons } from "../components/ReconnectingBanner.tsx";
import { accounts, activeAccount, DEFAULT_SERVER, isNative, normalizeServerUrl, serverUrl, setActiveAccount, setServerUrl, type SavedAccount } from "../lib/platform.ts";

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
      // A new account on this server: leave the signed-out account that may have been picked.
      await setActiveAccount(null);
      await setServerUrl(origin);
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

/** The app's remembered accounts on the sign-in screen: signed-in ones open directly, signed-out ones pre-fill the form. */
function SavedAccounts({ onPick }: { onPick: (account: SavedAccount) => void }) {
  const list = accounts();
  if (list.length === 0) return null;
  const active = activeAccount()?.id;
  return (
    <div className="card mb-3 overflow-hidden">
      <div className="border-b border-stone-200 px-4 py-2 text-xs text-stone-500 dark:border-stone-800">Choose an account</div>
      <ul className="max-h-64 divide-y divide-stone-200 overflow-y-auto dark:divide-stone-800">
        {list.map((a) => (
          <li key={a.id}>
            <AccountRow account={a} current={a.id === active} onClick={() => onPick(a)} />
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The session check couldn't reach the server (offline, server down): keep the sign-in, offer a retry. */
export function UnreachableView({ auth }: { auth: Auth }) {
  return (
    <div className="grid min-h-dvh place-items-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center justify-center gap-2">
          <img src="/logo.png" alt="" className="size-10" />
          <span className="text-xl font-semibold tracking-tight">SpecHarvest</span>
        </div>
        <div className="card space-y-4 p-5 sm:p-6">
          <h1 className="text-lg font-semibold">Can't reach the server</h1>
          <p className="text-sm text-stone-600 dark:text-stone-400">
            {isNative ? <span className="font-medium">{host(serverUrl())}</span> : "SpecHarvest"} isn't answering. Check your connection — you're still signed in.
          </p>
          <button className="btn-primary w-full" onClick={auth.retry}>
            Retry
          </button>
          <LeaveServerButtons auth={auth} switchLabel="Switch account or server" />
        </div>
      </div>
    </div>
  );
}

export function LoginView({ auth }: { auth: Auth }) {
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [signupEnabled, setSignupEnabled] = useState(false);
  const [email, setEmail] = useState(() => activeAccount()?.email ?? "");
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
          <SavedAccounts
            onPick={(a) => {
              if (a.token) return void auth.switchTo(a.id);
              // Signed out: sign in again to that account's server, email filled in.
              void setActiveAccount(a.id).then(() => {
                setEmail(a.email);
                setPassword("");
                setMode("login");
                setError(null);
                setServer((n) => n + 1);
              });
            }}
          />
        )}
        {isNative && (
          <div className="mb-3">
            <ServerPicker key={server} onChanged={() => (setServer((n) => n + 1), setError(null))} />
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
        {auth.cancelAdd && (
          <button type="button" className="btn-ghost mt-3 w-full" onClick={auth.cancelAdd}>
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}
