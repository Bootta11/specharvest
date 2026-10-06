import { useEffect, useState, type FormEvent } from "react";
import { api } from "../lib/api.ts";
import type { Auth } from "../lib/auth.ts";
import { Field, Notice } from "../components/Modal.tsx";

export function LoginView({ auth }: { auth: Auth }) {
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [signupEnabled, setSignupEnabled] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.authStatus().then((s) => setSignupEnabled(s.signupEnabled), () => {});
  }, []);

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
          <img src="/favicon.svg" alt="" className="size-9" />
          <span className="text-xl font-semibold tracking-tight">SpecHarvest</span>
        </div>
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
