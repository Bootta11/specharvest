import { useEffect, useState } from "react";
import type { UserSummary } from "@specharvest/shared";
import { ReconnectingBanner } from "../components/ReconnectingBanner.tsx";
import { useAuth, type Auth } from "../lib/auth.ts";
import { LoginView, UnreachableView } from "../views/LoginView.tsx";
import { BrowsersPage } from "./BrowsersPage.tsx";
import { SettingsPage } from "./SettingsPage.tsx";
import { UsagePage } from "./UsagePage.tsx";
import { UsersPage } from "./UsersPage.tsx";

const TABS = [
  { id: "users", label: "Users" },
  { id: "settings", label: "Settings" },
  { id: "browsers", label: "Browser servers" },
  { id: "usage", label: "Usage" },
] as const;
type Tab = (typeof TABS)[number]["id"];

/** The tab in the URL hash (`/admin/#browsers`), so reloads and links keep it. */
const tabFromHash = (): Tab => TABS.find((t) => `#${t.id}` === location.hash)?.id ?? "users";

/** The admin dashboard at /admin/: its own page, separate from the app (which only links here). */
export default function AdminApp() {
  const auth = useAuth();
  if (auth.unreachable) return <UnreachableView auth={auth} />;
  if (auth.user === undefined) return <ReconnectingBanner fullscreen />;
  if (auth.user === null) return <LoginView auth={auth} />;
  if (auth.user.role !== "admin") return <NotAdmin user={auth.user} auth={auth} />;
  return <Dashboard key={auth.user.id} user={auth.user} auth={auth} />;
}

function NotAdmin({ user, auth }: { user: UserSummary; auth: Auth }) {
  return (
    <div className="grid min-h-dvh place-items-center px-4">
      <div className="card w-full max-w-sm space-y-4 p-6 text-center">
        <img src="/logo.png" alt="" className="mx-auto size-12" />
        <h1 className="text-lg font-semibold">Admin access required</h1>
        <p className="text-sm text-stone-500">
          You're signed in as <span className="font-medium text-stone-700 dark:text-stone-200">{user.email}</span>, which isn't an admin account.
        </p>
        <div className="flex flex-col gap-2 sm:flex-row sm:justify-center">
          <a className="btn-primary" href="/">
            Back to the app
          </a>
          <button className="btn-ghost" onClick={auth.logout}>
            Sign out
          </button>
        </div>
      </div>
    </div>
  );
}

function Dashboard({ user, auth }: { user: UserSummary; auth: Auth }) {
  const [tab, setTab] = useState<Tab>(tabFromHash);

  useEffect(() => {
    const onHash = () => setTab(tabFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const current = TABS.find((t) => t.id === tab)!;
  useEffect(() => {
    document.title = `${current.label} · SpecHarvest admin`;
  }, [current]);

  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-20 border-b border-stone-200 bg-white/85 backdrop-blur dark:border-stone-800 dark:bg-stone-950/85">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-3 gap-y-2 py-2 pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))] md:h-14 md:flex-nowrap md:py-0">
          <img src="/logo.png" alt="" className="size-8 shrink-0" />
          <span className="font-semibold tracking-tight">
            <span className="hidden sm:inline">SpecHarvest </span>Admin
          </span>
          <div className="ml-auto flex shrink-0 items-center gap-2 md:order-last">
            <span className="hidden max-w-48 truncate text-xs text-stone-500 lg:inline" title={user.email}>
              {user.email}
            </span>
            <a className="btn-ghost btn-sm" href="/">
              ← Back to app
            </a>
            <button className="btn-ghost btn-sm" onClick={auth.logout}>
              Sign out
            </button>
          </div>
          {/* Phones: the tabs get their own full-width row and scroll sideways if they don't fit. */}
          <nav className="order-last -mx-1 flex w-full gap-1 overflow-x-auto px-1 pb-1 text-sm md:order-none md:mx-0 md:w-auto md:px-0 md:pb-0" aria-label="Admin">
            {TABS.map((t) => (
              <a
                key={t.id}
                href={`#${t.id}`}
                className={`shrink-0 whitespace-nowrap rounded-md px-3 py-1.5 font-medium transition ${
                  tab === t.id ? "bg-brand-50 text-brand-800 dark:bg-brand-900/40 dark:text-brand-100" : "text-stone-600 hover:bg-stone-100 hover:text-stone-900 dark:text-stone-400 dark:hover:bg-stone-800"
                }`}
                aria-current={tab === t.id ? "page" : undefined}
              >
                {t.label}
              </a>
            ))}
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-4 py-6">
        <ReconnectingBanner />
        <h1 className="sr-only">{current.label}</h1>
        {tab === "users" && <UsersPage me={user} />}
        {tab === "settings" && <SettingsPage />}
        {tab === "browsers" && <BrowsersPage />}
        {tab === "usage" && <UsagePage />}
      </main>
    </div>
  );
}
