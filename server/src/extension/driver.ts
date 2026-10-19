import type { ExtensionCommand } from "@specharvest/shared";
import type { PageScriptArgs, PageScriptName, PageScriptResult } from "@specharvest/shared/page-scripts";
import { FatalDriverError, type PageDriver } from "../crawler/driver.ts";
import {
  acquireTab,
  connectionFor,
  ExtensionCommandError,
  ExtensionOfflineError,
  releaseTab,
  sendCommand,
  waitForPermissionGrant,
  type Connection,
} from "./gateway.ts";

/** How long a job waits for the user to allow the extension on a site before it stops (resumable). */
const PERMISSION_WAIT_MS = 5 * 60_000;
/** Slack on top of a command's own timeout for the round trip. */
const RPC_SLACK_MS = 15_000;
const SCRIPT_TIMEOUT_MS = 60_000;
/** A page load plus a few scrolls. */
const PROBE_TIMEOUT_MS = 90_000;

/** Called with a short status line while the crawl waits on the user (shown as the job's message). */
export type Notice = (message: string) => void;

const siteOf = (origin: string | undefined) => {
  try {
    return origin ? new URL(origin).hostname.replace(/^www\./, "") : "this site";
  } catch {
    return "this site";
  }
};

/** How a page waits on the user. */
export interface WaitOptions {
  /** Status lines while waiting (shown as the job's message). */
  notice?: Notice;
  /** How long to wait for the user to allow a site; 0 fails at once (quick checks shouldn't hang). */
  permissionWaitMs?: number;
  /** The job was stopped: stop waiting. */
  signal?: AbortSignal;
  /** The site the pages are for: the extension opens sites it knows need a visible window there right away. */
  origin?: string;
}

/**
 * Runs `send`; when the extension lacks the site permission, tells the user and waits for them to grant it
 * (the extension shows a notification), then tries again. Gives up — the job stops, resumable — after
 * `permissionWaitMs`, or at once when the job is stopped.
 */
async function withPermission<T>(c: Connection, wait: WaitOptions, send: () => Promise<T>): Promise<T> {
  const waitMs = wait.permissionWaitMs ?? PERMISSION_WAIT_MS;
  for (;;) {
    try {
      return await send();
    } catch (err) {
      if (!(err instanceof ExtensionCommandError) || err.code !== "needs_permission") throw err;
      const site = siteOf(err.origin);
      if (waitMs <= 0) throw new FatalDriverError(`The extension isn't allowed on ${site} yet`);
      // Chrome grants site access only in answer to a click on that computer — say so: the job may have been started from a phone.
      wait.notice?.(
        `Waiting for you to allow the SpecHarvest extension on ${site} on your computer — click its notification or toolbar icon. To skip this next time, turn on “Allow on all sites” in the extension's settings`,
      );
      if (!(await waitForPermissionGrant(c, waitMs, wait.signal))) {
        throw new FatalDriverError(wait.signal?.aborted ? "Stopped" : `The extension wasn't allowed on ${site} — allow it on your computer (or turn on “Allow on all sites” in the extension's settings), then resume`);
      }
      wait.notice?.(`Allowed on ${site} — continuing`);
    }
  }
}

/** How long a lost tab waits to see whether the whole browser went away (Chrome closes tabs before the socket). */
const SHUTDOWN_GRACE_MS = 2_000;

/**
 * Sends a command for a tab. When the tab is gone (closed, or Chrome is shutting down), waits a moment: if
 * the connection drops too, that's the browser going away — the job stops, resumable — not this page failing.
 */
async function tabCommand(c: Connection, command: ExtensionCommand, timeoutMs: number): Promise<unknown> {
  try {
    return await sendCommand(c, command, timeoutMs);
  } catch (err) {
    const tabLost = err instanceof ExtensionCommandError && (err.code === "tab_closed" || /shutting down|no tab with id/i.test(err.message));
    if (tabLost) {
      await new Promise((r) => setTimeout(r, SHUTDOWN_GRACE_MS));
      if (c.closed) throw new ExtensionOfflineError("Your browser disconnected (Chrome closed, or the SpecHarvest extension stopped)");
    }
    throw err;
  }
}

/** A tab in the user's own Chrome, driven over the extension's socket. */
class ExtensionDriver implements PageDriver {
  readonly runner = "browser" as const;
  constructor(
    private readonly c: Connection,
    private readonly tabId: number,
    private readonly wait: WaitOptions,
  ) {}

  async goto(url: string, opts: { timeoutMs: number }) {
    const result = await withPermission(this.c, this.wait, () =>
      tabCommand(this.c, { op: "goto", tabId: this.tabId, url, timeoutMs: opts.timeoutMs }, opts.timeoutMs + RPC_SLACK_MS),
    );
    const status = (result as { status?: unknown } | null)?.status;
    return { status: typeof status === "number" ? status : null };
  }

  async run<K extends PageScriptName>(name: K, ...args: PageScriptArgs<K>): Promise<PageScriptResult<K>> {
    // A redirect can land on a site the extension may not open yet.
    return (await withPermission(this.c, this.wait, () =>
      tabCommand(this.c, { op: "run", tabId: this.tabId, script: name, args }, SCRIPT_TIMEOUT_MS),
    )) as PageScriptResult<K>;
  }

  async click(selector: string) {
    const clicked = await this.run("clickSelector", { selector });
    if (!clicked) throw new Error(`No element matches ${selector}`);
  }

  async ensureVisible(reason: "infiniteScroll") {
    const site = siteOf(this.wait.origin);
    if (!this.c.autoVisible) {
      return { message: `${site} loads more items as you scroll, but your extension keeps crawl windows minimized, where pages don't scroll — this crawl may miss items`, warn: true };
    }
    const r = (await tabCommand(this.c, { op: "showTab", tabId: this.tabId, reason }, 30_000)) as { moved?: unknown } | null;
    return r?.moved ? { message: `${site} loads more items as you scroll — moved the crawl to a background window so the page renders`, warn: false } : null;
  }

  async checkScrollLoading(url: string) {
    if (!this.c.autoVisible) return { loadsOnScroll: false, message: null };
    const r = (await withPermission(this.c, this.wait, () =>
      tabCommand(this.c, { op: "probeScroll", tabId: this.tabId, url, timeoutMs: PROBE_TIMEOUT_MS }, PROBE_TIMEOUT_MS + RPC_SLACK_MS),
    )) as { checked?: unknown; needsVisible?: unknown } | null;
    const site = siteOf(url);
    if (!r?.needsVisible) return { loadsOnScroll: false, message: r?.checked ? `Checked ${site}: its listings don't need a visible window` : null };
    return {
      loadsOnScroll: true,
      message: r.checked
        ? `${site} loads more items as you scroll — its crawls run in a background window, since minimized pages don't scroll`
        : `Running in a background window — ${site} loads more items as you scroll`,
    };
  }

  async waitForNetworkIdle(opts: { idleMs: number; timeoutMs: number }) {
    await tabCommand(this.c, { op: "waitIdle", tabId: this.tabId, ...opts }, opts.timeoutMs + RPC_SLACK_MS).catch((err) => {
      if (err instanceof FatalDriverError) throw err;
    });
  }
}

function requireConnection(userId: number | null): Connection {
  const c = connectionFor(userId);
  if (!c) throw new ExtensionOfflineError("Your browser isn't connected — open Chrome with the SpecHarvest extension signed in, then resume");
  return c;
}

/** Opens a tab in the user's Chrome for `fn`, within the tab limit the user set in the extension. */
export async function withExtensionPage<T>(userId: number | null, fn: (page: PageDriver) => Promise<T>, wait: WaitOptions = {}): Promise<T> {
  const c = requireConnection(userId);
  await acquireTab(c);
  try {
    const opened = (await sendCommand(c, { op: "openTab", ...(wait.origin ? { origin: wait.origin } : {}) }, 30_000)) as { tabId?: unknown };
    if (typeof opened?.tabId !== "number") throw new Error("The extension couldn't open a tab");
    const tabId = opened.tabId;
    try {
      return await fn(new ExtensionDriver(c, tabId, wait));
    } finally {
      await sendCommand(c, { op: "closeTab", tabId }, 10_000).catch(() => {});
    }
  } finally {
    releaseTab(c);
  }
}

/**
 * Before a crawl starts in the user's browser: is it connected, and may the extension open `url`'s site?
 * Asks the user right away (rather than at the first page) and waits like a page load would.
 */
export async function prepareBrowserRunner(userId: number | null, url: string, wait: WaitOptions = {}) {
  const c = requireConnection(userId);
  const origin = new URL(url).origin;
  await withPermission(c, wait, async () => {
    const r = (await sendCommand(c, { op: "ensurePermission", origin, reason: "crawl" }, 30_000)) as { granted?: unknown };
    if (r?.granted !== true) throw new ExtensionCommandError("needs_permission", "Site permission needed", origin);
  });
}
