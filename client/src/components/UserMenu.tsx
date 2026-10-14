import { useEffect, useRef, useState } from "react";
import type { UserSummary } from "@specharvest/shared";
import { accounts, activeAccount, isNative, serverUrl } from "../lib/platform.ts";
import { AccountRow } from "./AccountRow.tsx";

/** Header avatar with the account / admin / sign-out menu; in the app also the saved accounts to switch to. */
export function UserMenu({
  user,
  onAccount,
  onLlm,
  onAdmin,
  onServers,
  onLogout,
  onSwitch,
  onAddAccount,
}: {
  user: UserSummary;
  onAccount: () => void;
  onLlm: () => void;
  onAdmin: () => void;
  onServers: () => void;
  onLogout: () => void;
  onSwitch: (id: string) => void;
  onAddAccount: () => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => !rootRef.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const pick = (fn: () => void) => () => {
    setOpen(false);
    fn();
  };
  const item = "block w-full px-4 py-2.5 text-left text-sm hover:bg-stone-100 dark:hover:bg-stone-800";

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        onClick={() => setOpen((o) => !o)}
        className="grid size-8 place-items-center rounded-full bg-brand-700 text-sm font-semibold uppercase text-white hover:bg-brand-800"
        title={user.email}
        aria-label="Account menu"
        aria-expanded={open}
        aria-haspopup="menu"
      >
        {user.email.charAt(0)}
      </button>
      {open && (
        <div role="menu" className="card absolute right-0 top-full z-30 mt-2 w-72 max-w-[calc(100vw-2rem)] overflow-hidden py-1 shadow-lg">
          <div className="border-b border-stone-200 px-4 py-2.5 dark:border-stone-800">
            <div className="truncate text-sm font-medium" title={user.email}>
              {user.email}
            </div>
            <div className="truncate text-xs text-stone-500">
              {user.role === "admin" ? "Admin" : "User"}
              {isNative && ` · ${serverUrl().replace(/^https?:\/\//, "")}`}
            </div>
          </div>
          <button role="menuitem" className={item} onClick={pick(onAccount)}>
            Account & API keys
          </button>
          <button role="menuitem" className={item} onClick={pick(onLlm)}>
            LLM provider
          </button>
          {user.role === "admin" && (
            <>
              <button role="menuitem" className={item} onClick={pick(onAdmin)}>
                Users & sign-up
              </button>
              <button role="menuitem" className={item} onClick={pick(onServers)}>
                Browser servers
              </button>
            </>
          )}
          {isNative && (
            <div className="border-y border-stone-200 py-1 dark:border-stone-800">
              <div className="max-h-56 overflow-y-auto">
                {accounts()
                  .filter((a) => a.id !== activeAccount()?.id)
                  .map((a) => (
                    <AccountRow key={a.id} account={a} onClick={pick(() => onSwitch(a.id))} />
                  ))}
              </div>
              <button role="menuitem" className={item} onClick={pick(onAddAccount)}>
                Add account
              </button>
            </div>
          )}
          <button role="menuitem" className={`${item} text-red-700 dark:text-red-300`} onClick={pick(onLogout)}>
            {isNative && accounts().length > 1 ? "Sign out of this account" : "Sign out"}
          </button>
        </div>
      )}
    </div>
  );
}
