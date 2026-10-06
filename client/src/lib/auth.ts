import { useCallback, useEffect, useState } from "react";
import type { UserSummary } from "@specharvest/shared";
import { api, UNAUTHORIZED_EVENT } from "./api.ts";

export interface Auth {
  /** undefined while checking the session, null when signed out. */
  user: UserSummary | null | undefined;
  login: (email: string, password: string) => Promise<void>;
  signup: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  setUser: (user: UserSummary) => void;
}

export function useAuth(): Auth {
  const [user, setUser] = useState<UserSummary | null | undefined>(undefined);

  useEffect(() => {
    api.me().then(setUser, () => setUser(null));
    const onLost = () => setUser(null);
    window.addEventListener(UNAUTHORIZED_EVENT, onLost);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onLost);
  }, []);

  const login = useCallback(async (email: string, password: string) => setUser(await api.login(email, password)), []);
  const signup = useCallback(async (email: string, password: string) => setUser(await api.signup(email, password)), []);
  const logout = useCallback(async () => {
    await api.logout().catch(() => {});
    setUser(null);
  }, []);

  return { user, login, signup, logout, setUser };
}
