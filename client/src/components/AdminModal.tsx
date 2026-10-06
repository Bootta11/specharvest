import { useEffect, useState, type FormEvent } from "react";
import type { UserCreated, UserRole, UserSummary } from "@specharvest/shared";
import { api } from "../lib/api.ts";
import { Modal, Notice, OneTimeSecret } from "./Modal.tsx";

export function AdminModal({ me, onClose }: { me: UserSummary; onClose: () => void }) {
  const [users, setUsers] = useState<UserSummary[] | null>(null);
  const [signupEnabled, setSignupEnabled] = useState<boolean | null>(null);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<UserRole>("user");
  const [created, setCreated] = useState<UserCreated | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fail = (err: unknown) => setError((err as Error).message);
  const load = () => api.users().then(setUsers, fail);
  useEffect(() => {
    load();
    api.adminSettings().then((s) => setSignupEnabled(s.signupEnabled), fail);
  }, []);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      setCreated(await api.createUser(email.trim(), role));
      setEmail("");
      setRole("user");
      load();
    } catch (err) {
      fail(err);
    }
  };

  const toggleDisabled = async (u: UserSummary) => {
    const disable = u.disabledAt === null;
    if (disable && !window.confirm(`Disable ${u.email}? They are signed out and can't sign in until re-enabled. Their collections stay.`)) return;
    setError(null);
    await api.setUserDisabled(u.id, disable).catch(fail);
    load();
  };

  const toggleSignup = async (on: boolean) => {
    setError(null);
    try {
      setSignupEnabled((await api.saveAdminSettings({ signupEnabled: on })).signupEnabled);
    } catch (err) {
      fail(err);
    }
  };

  return (
    <Modal title="Users & sign-up" onClose={onClose}>
      {error && <Notice kind="error">{error}</Notice>}

      <section className="space-y-3">
        <h3 className="text-sm font-semibold">Add a user</h3>
        <form onSubmit={create} className="flex flex-col gap-2 sm:flex-row">
          <input className="input" type="email" placeholder="email@example.com" required value={email} onChange={(e) => setEmail(e.target.value)} />
          <div className="flex gap-2">
            <select className="input w-auto" value={role} onChange={(e) => setRole(e.target.value as UserRole)} aria-label="Role">
              <option value="user">User</option>
              <option value="admin">Admin</option>
            </select>
            <button className="btn-primary flex-1 sm:flex-none">Add</button>
          </div>
        </form>
        {created && <OneTimeSecret label={`Temporary password for ${created.email}`} value={created.temporaryPassword} />}
      </section>

      <section className="space-y-2">
        <h3 className="text-sm font-semibold">Users</h3>
        {!users ? (
          <p className="text-sm text-stone-500">Loading…</p>
        ) : (
          <ul className="divide-y divide-stone-200 rounded-lg border border-stone-200 text-sm dark:divide-stone-800 dark:border-stone-800">
            {users.map((u) => (
              <li key={u.id} className="flex items-center gap-3 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <div className={`truncate font-medium ${u.disabledAt ? "text-stone-400 line-through" : ""}`} title={u.email}>
                    {u.email}
                  </div>
                  <div className="text-xs text-stone-500">
                    {u.role === "admin" ? "Admin" : "User"}
                    {u.id === me.id && " · you"}
                    {u.disabledAt && " · disabled"} · since {new Date(u.createdAt).toLocaleDateString()}
                  </div>
                </div>
                {u.id !== me.id && (
                  <button className={`btn-ghost btn-sm ${u.disabledAt ? "" : "text-red-700 dark:text-red-300"}`} onClick={() => toggleDisabled(u)}>
                    {u.disabledAt ? "Enable" : "Disable"}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h3 className="mb-1 text-sm font-semibold">Sign-up</h3>
        <label className="flex cursor-pointer items-start gap-3 py-1.5">
          <input
            type="checkbox"
            className="mt-0.5 size-4 shrink-0 accent-brand-700"
            disabled={signupEnabled === null}
            checked={!!signupEnabled}
            onChange={(e) => toggleSignup(e.target.checked)}
          />
          <span className="min-w-0">
            <span className="block text-sm font-medium">Anyone can create an account</span>
            <span className="block text-xs text-stone-500">Shows "Create one" on the sign-in page. New accounts are regular users.</span>
          </span>
        </label>
      </section>
    </Modal>
  );
}
