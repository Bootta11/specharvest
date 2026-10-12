import { useCallback, useEffect, useState } from "react";
import type { UserSummary } from "@specharvest/shared";
import { api, ApiError, UNAUTHORIZED_EVENT } from "./api.ts";
import { accounts, activeAccount, isNative, markSignedOut, saveAccount, sessionToken, setActiveAccount } from "./platform.ts";

export interface Auth {
  /** undefined while checking the session, null when signed out. */
  user: UserSummary | null | undefined;
  /** The session check failed without the server saying no (offline, 5xx): the sign-in is kept, retry later. */
  unreachable: boolean;
  retry: () => void;
  login: (email: string, password: string) => Promise<void>;
  signup: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  /** Deletes the account (throws on a wrong password), then signs out like logout. */
  deleteAccount: (currentPassword: string) => Promise<void>;
  setUser: (user: UserSummary) => void;
  /** App: makes a saved account the active one and reloads, so every view and stream starts over for it. */
  switchTo: (id: string) => Promise<void>;
  /** App: the sign-in screen for another account, keeping the current one. */
  addAccount: () => Promise<void>;
  /** Set while adding an account: goes back to the account it was opened from. */
  cancelAdd: (() => void) | null;
}

export async function switchTo(id: string) {
  await setActiveAccount(id);
  location.reload();
}

export function useAuth(): Auth {
  const [user, setUser] = useState<UserSummary | null | undefined>(undefined);
  const [unreachable, setUnreachable] = useState(false);
  const [addingFrom, setAddingFrom] = useState<string | null>(null);

  const check = useCallback(() => {
    setUnreachable(false);
    // The app with no signed-in account has nothing to check.
    if (isNative && !sessionToken()) return setUser(null);
    setUser(undefined);
    api.me().then(
      (me) => {
        // Fills in an account carried over from an older build, and keeps email/role current.
        const account = activeAccount();
        if (account && (account.email !== me.email || account.role !== me.role || account.id !== `${account.server}#${me.id}`)) {
          void saveAccount(account.server, null, me);
        }
        setUser(me);
      },
      (err) => {
        if (err instanceof ApiError && err.status === 401) {
          const account = activeAccount();
          if (account) void markSignedOut(account.id);
          setUser(null);
        } else setUnreachable(true);
      },
    );
  }, []);

  useEffect(() => {
    check();
    const onLost = () => {
      const account = activeAccount();
      if (account) void markSignedOut(account.id);
      setUser(null);
    };
    window.addEventListener(UNAUTHORIZED_EVENT, onLost);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onLost);
  }, [check]);

  // Unreachable: try again when the app comes back to the foreground.
  useEffect(() => {
    if (!unreachable) return;
    const onVisible = () => document.visibilityState === "visible" && check();
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [unreachable, check]);

  const login = useCallback(async (email: string, password: string) => {
    setUser(await api.login(email, password));
    setAddingFrom(null);
  }, []);
  const signup = useCallback(async (email: string, password: string) => {
    setUser(await api.signup(email, password));
    setAddingFrom(null);
  }, []);
  // The app moves on to another signed-in account, if there is one.
  const leave = useCallback(async () => {
    const next = isNative ? accounts().find((a) => a.token) : undefined;
    if (next) await switchTo(next.id);
    else setUser(null);
  }, []);
  const logout = useCallback(async () => {
    await api.logout().catch(() => {});
    await leave();
  }, [leave]);
  const deleteAccount = useCallback(
    async (currentPassword: string) => {
      await api.deleteAccount(currentPassword);
      await leave();
    },
    [leave],
  );

  const addAccount = useCallback(async () => {
    setAddingFrom(activeAccount()?.id ?? null);
    await setActiveAccount(null);
    setUnreachable(false);
    setUser(null);
  }, []);

  const cancelAdd = addingFrom ? () => void switchTo(addingFrom) : null;

  return { user, unreachable, retry: check, login, signup, logout, deleteAccount, setUser, switchTo, addAccount, cancelAdd };
}
