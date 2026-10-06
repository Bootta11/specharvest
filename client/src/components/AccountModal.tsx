import { useEffect, useState, type FormEvent } from "react";
import type { ApiKeyCreated, ApiKeySummary, UserSummary } from "@specharvest/shared";
import { api } from "../lib/api.ts";
import { Field, Modal, Notice, OneTimeSecret } from "./Modal.tsx";

const date = (ts: number | null) => (ts ? new Date(ts).toLocaleDateString() : "never");

function Profile({ user, onUpdated }: { user: UserSummary; onUpdated: (u: UserSummary) => void }) {
  const [email, setEmail] = useState(user.email);
  const [newPassword, setNewPassword] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      const updated = await api.updateAccount({
        currentPassword,
        email: email.trim() !== user.email ? email.trim() : undefined,
        newPassword: newPassword || undefined,
      });
      onUpdated(updated);
      setCurrentPassword("");
      setNewPassword("");
      setMsg({ kind: "ok", text: newPassword ? "Saved — other devices were signed out." : "Saved." });
    } catch (err) {
      setMsg({ kind: "error", text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const changed = email.trim() !== user.email || newPassword.length > 0;

  return (
    <form onSubmit={submit} className="space-y-3">
      <h3 className="text-sm font-semibold">Profile</h3>
      {msg && <Notice kind={msg.kind}>{msg.text}</Notice>}
      <Field label="Email">
        <input className="input" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
      </Field>
      <Field label="New password" hint="Leave blank to keep the current one. At least 8 characters.">
        <input className="input" type="password" autoComplete="new-password" minLength={8} value={newPassword} onChange={(e) => setNewPassword(e.target.value)} />
      </Field>
      <Field label="Current password" hint="Needed to change your email or password.">
        <input className="input" type="password" autoComplete="current-password" required value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} />
      </Field>
      <div className="flex justify-end">
        <button className="btn-primary" disabled={busy || !changed}>
          Save changes
        </button>
      </div>
    </form>
  );
}

function ApiKeys() {
  const [keys, setKeys] = useState<ApiKeySummary[] | null>(null);
  const [label, setLabel] = useState("");
  const [created, setCreated] = useState<ApiKeyCreated | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () => api.apiKeys().then(setKeys, (err) => setError((err as Error).message));
  useEffect(() => {
    load();
  }, []);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      setCreated(await api.createApiKey(label.trim()));
      setLabel("");
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const revoke = async (k: ApiKeySummary) => {
    if (!window.confirm(`Revoke "${k.label}"? Scripts using it stop working.`)) return;
    await api.revokeApiKey(k.id).catch((err) => setError((err as Error).message));
    if (created?.id === k.id) setCreated(null);
    load();
  };

  return (
    <section className="space-y-3">
      <div>
        <h3 className="text-sm font-semibold">API keys</h3>
        <p className="text-xs text-stone-500">
          For scripts: send the key as an <code>X-Api-Key</code> header. It acts as you.
        </p>
      </div>
      {error && <Notice kind="error">{error}</Notice>}
      {created && <OneTimeSecret label={`Key "${created.label}"`} value={created.key} />}
      <form onSubmit={create} className="flex gap-2">
        <input className="input" placeholder="Label, e.g. home-server cron" required maxLength={100} value={label} onChange={(e) => setLabel(e.target.value)} />
        <button className="btn-ghost">Create</button>
      </form>
      {keys && keys.length > 0 && (
        <ul className="divide-y divide-stone-200 rounded-lg border border-stone-200 text-sm dark:divide-stone-800 dark:border-stone-800">
          {keys.map((k) => (
            <li key={k.id} className="flex items-center gap-3 px-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{k.label}</div>
                <div className="truncate text-xs text-stone-500">
                  <code>{k.keyPrefix}…</code> · created {date(k.createdAt)} · last used {date(k.lastUsedAt)}
                </div>
              </div>
              <button className="btn-ghost btn-sm text-red-700 dark:text-red-300" onClick={() => revoke(k)}>
                Revoke
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function AccountModal({ user, onUpdated, onClose }: { user: UserSummary; onUpdated: (u: UserSummary) => void; onClose: () => void }) {
  return (
    <Modal title="Account" onClose={onClose}>
      <Profile user={user} onUpdated={onUpdated} />
      <ApiKeys />
    </Modal>
  );
}
