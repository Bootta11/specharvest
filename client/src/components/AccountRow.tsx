import type { SavedAccount } from "../lib/platform.ts";

/** "https://example.com" → "example.com". */
export const host = (server: string) => server.replace(/^https?:\/\//, "");

/** One saved account: avatar, email, server and — without a token — a "Signed out" badge. */
export function AccountRow({ account, current, onClick }: { account: SavedAccount; current?: boolean; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className={`flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-stone-100 dark:hover:bg-stone-800 ${current ? "bg-stone-50 dark:bg-stone-900" : ""}`}>
      <span className="grid size-8 shrink-0 place-items-center rounded-full bg-brand-700 text-sm font-semibold uppercase text-white">{(account.email || "?").charAt(0)}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{account.email || "Signed-in account"}</span>
        <span className="block truncate text-xs text-stone-500">{host(account.server)}</span>
      </span>
      {!account.token && <span className="shrink-0 rounded-full bg-stone-100 px-2 py-0.5 text-xs text-stone-600 dark:bg-stone-800 dark:text-stone-300">Signed out</span>}
    </button>
  );
}
