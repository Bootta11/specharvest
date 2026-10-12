import type { PageScriptArgs, PageScriptName, PageScriptResult } from "@specharvest/shared/page-scripts";

/** Which browser does the work: the server's puppeteer Chrome, or the user's own Chrome via the extension. */
export type Runner = "server" | "browser";

/**
 * One browser tab, as the crawler sees it. The crawler only navigates, runs the shared page scripts
 * (`@specharvest/shared/page-scripts`), clicks and waits — so a tab in the server's puppeteer Chrome and a
 * tab in the user's Chrome (driven over the extension's WebSocket) look the same to it.
 */
export interface PageDriver {
  readonly runner: Runner;
  /** Navigates and waits for `load`. `status` is the main document's HTTP status when known. */
  goto(url: string, opts: { timeoutMs: number }): Promise<{ status: number | null }>;
  run<K extends PageScriptName>(name: K, ...args: PageScriptArgs<K>): Promise<PageScriptResult<K>>;
  /** Clicks the first element matching `selector`; rejects when there is none. */
  click(selector: string): Promise<void>;
  /** Resolves once no request has been in flight for `idleMs` — or after `timeoutMs`, whichever is first. */
  waitForNetworkIdle(opts: { idleMs: number; timeoutMs: number }): Promise<void>;
  /**
   * Makes sure the page renders (hidden pages don't lay out or scroll, so "load more on scroll" never fires).
   * Only runners that can hide pages implement it; returns a line for the job log, or null when nothing changed.
   */
  ensureVisible?(reason: "infiniteScroll"): Promise<{ message: string; warn: boolean } | null>;
  /**
   * Before a listing: checks (once per site, remembered by the runner) whether `url` loads more items as you
   * scroll, and if so keeps the page visible. `message`: a line for the job log.
   */
  checkScrollLoading?(url: string): Promise<{ loadsOnScroll: boolean; message: string | null }>;
}

/**
 * The runner itself failed (the user's browser disconnected, a site permission is missing…): retrying the
 * same page can't help, so navigation passes it straight up to the job.
 */
export class FatalDriverError extends Error {}

/** Re-runs a page script until it returns true; false when `timeoutMs` passes first. */
export async function waitForScript<K extends PageScriptName>(
  driver: PageDriver,
  timeoutMs: number,
  name: K,
  ...args: PageScriptArgs<K>
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await driver.run(name, ...args).catch(() => false)) === true) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}
