import { useEffect, useRef, useState } from "react";
import type { UserSummary } from "@specharvest/shared";

/** Header avatar with the account / admin / sign-out menu. */
export function UserMenu({ user, onAccount, onLlm, onAdmin, onLogout }: { user: UserSummary; onAccount: () => void; onLlm: () => void; onAdmin: () => void; onLogout: () => void }) {
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
    <div ref={rootRef} className="relative">
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
        <div role="menu" className="card absolute right-0 top-full z-30 mt-2 w-60 overflow-hidden py-1 shadow-lg">
          <div className="border-b border-stone-200 px-4 py-2.5 dark:border-stone-800">
            <div className="truncate text-sm font-medium" title={user.email}>
              {user.email}
            </div>
            <div className="text-xs text-stone-500">{user.role === "admin" ? "Admin" : "User"}</div>
          </div>
          <button role="menuitem" className={item} onClick={pick(onAccount)}>
            Account & API keys
          </button>
          <button role="menuitem" className={item} onClick={pick(onLlm)}>
            LLM provider
          </button>
          {user.role === "admin" && (
            <button role="menuitem" className={item} onClick={pick(onAdmin)}>
              Users & sign-up
            </button>
          )}
          <button role="menuitem" className={`${item} text-red-700 dark:text-red-300`} onClick={pick(onLogout)}>
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
