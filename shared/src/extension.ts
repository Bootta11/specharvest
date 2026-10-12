import { z } from "zod";

/**
 * The SpecHarvest browser extension lets a crawl load pages in the user's own Chrome. The server drives it
 * over one WebSocket (`/api/extension/ws`): it sends small commands (open a tab, go to a URL, run one of the
 * bundled page scripts, click), the extension answers each one. No code ever travels — only script names
 * and JSON arguments. See docs/extension.md.
 */

/** Bumped when either side can no longer talk to the other; the extension shows "please update". */
export const EXTENSION_PROTOCOL = 1;

export const EXTENSION_MAX_CONCURRENCY = 4;
export const EXTENSION_DEFAULT_CONCURRENCY = 2;

/** Prefix of extension tokens (`api_keys.kind = 'extension'`); plain API keys start with `shk_`. */
export const EXTENSION_TOKEN_PREFIX = "shx_";

// ---------- extension → server ----------

export const extensionHelloSchema = z.object({
  type: z.literal("hello"),
  token: z.string().min(10).max(200),
  protocol: z.number().int(),
  /** The extension's version (manifest). */
  version: z.string().max(40),
  /** Tabs it may use at once (user setting). */
  concurrency: z.number().int().min(1).max(EXTENSION_MAX_CONCURRENCY),
  /** May a crawl tab move to a visible background window when a site loads items on scroll (user setting)? */
  autoVisible: z.boolean().default(true),
});

/** Why a command failed, so the server can react (wait for a permission, give up on the runner…). */
export const extensionErrorCodes = [
  /** The extension has no host permission for `origin` yet; the user is being asked. */
  "needs_permission",
  /** The extension refuses the URL (localhost, private network…). */
  "blocked_url",
  /** The tab was closed (by the user, or crashed). */
  "tab_closed",
  "timeout",
  "navigation_failed",
  "script_failed",
  "bad_command",
] as const;
export type ExtensionErrorCode = (typeof extensionErrorCodes)[number];

export const extensionReplySchema = z.discriminatedUnion("ok", [
  z.object({ type: z.literal("reply"), id: z.number().int(), ok: z.literal(true), result: z.unknown() }),
  z.object({
    type: z.literal("reply"),
    id: z.number().int(),
    ok: z.literal(false),
    code: z.enum(extensionErrorCodes),
    message: z.string().max(2000),
    /** needs_permission: the origin to ask for. */
    origin: z.string().max(300).optional(),
  }),
]);

export const extensionClientMessageSchema = z.union([
  extensionReplySchema,
  z.object({ type: z.literal("ping") }),
  /** The user allowed the extension on a site (a job waiting for it can go on). */
  z.object({ type: z.literal("permissionGranted"), origin: z.string().max(300) }),
  /** Settings changed in the extension. */
  z.object({ type: z.literal("settings"), concurrency: z.number().int().min(1).max(EXTENSION_MAX_CONCURRENCY), autoVisible: z.boolean().default(true) }),
]);
export type ExtensionClientMessage = z.infer<typeof extensionClientMessageSchema>;

// ---------- server → extension ----------

export type ExtensionCommand =
  /** `origin`: the site the tab is for — sites remembered as needing a visible window open there right away. */
  | { op: "openTab"; origin?: string }
  /**
   * Hidden pages (minimized window, background tab) don't lay out or scroll, so "load more on scroll" never
   * fires: move the tab to a visible background window. Replies `{ moved, visible }`.
   */
  | { op: "showTab"; tabId: number; reason: "infiniteScroll" }
  /**
   * Once per site: load `url`, show it in a visible window, scroll, and see whether more items appear. If so
   * the tab stays visible (and the site is remembered); if not it goes back. Replies `{ checked, needsVisible }`.
   */
  | { op: "probeScroll"; tabId: number; url: string; timeoutMs: number }
  | { op: "goto"; tabId: number; url: string; timeoutMs: number }
  | { op: "run"; tabId: number; script: string; args: unknown[] }
  | { op: "click"; tabId: number; selector: string }
  | { op: "waitIdle"; tabId: number; idleMs: number; timeoutMs: number }
  | { op: "closeTab"; tabId: number }
  /** The pages of a job are about to go to `origin`: ask the user now if the extension may not open it yet. */
  | { op: "ensurePermission"; origin: string; reason: string };

export type ExtensionServerMessage =
  | { type: "welcome"; email: string; deviceName: string }
  | { type: "command"; id: number; command: ExtensionCommand }
  | { type: "pong" }
  /** The connection is refused or replaced; `reason` is shown to the user. */
  | { type: "bye"; reason: string; code: "bad_token" | "outdated" | "replaced" | "revoked" | "timeout" };

// ---------- REST ----------

/** The extension as the web app sees it (`GET /api/extension/status`). */
export interface ExtensionStatus {
  online: boolean;
  deviceName: string | null;
  version: string | null;
  concurrency: number | null;
}

/** One connected browser (`GET /api/extension/devices`): an extension token. */
export interface ExtensionDevice {
  id: number;
  name: string;
  /** approve = paired by approving in the web app; token = a token created by hand and pasted. */
  via: "approve" | "token";
  keyPrefix: string;
  createdAt: number;
  lastUsedAt: number | null;
  online: boolean;
}

export const pairApproveSchema = z.object({
  /** base64url sha256 of the extension's secret verifier. */
  challenge: z.string().regex(/^[\w-]{43}$/),
  deviceName: z.string().trim().min(1).max(80),
});

/** The short code the extension and the approve page both show, so the user can tell it's the same request. */
export const pairingCode = (challenge: string) => `${challenge.slice(0, 4)}-${challenge.slice(4, 8)}`.toUpperCase();

export const pairClaimSchema = z.object({ verifier: z.string().regex(/^[\w-]{43,128}$/) });

export const createDeviceTokenSchema = z.object({ name: z.string().trim().min(1).max(80) });

export interface PairClaimResult {
  token: string;
  email: string;
  deviceName: string;
}

/** `GET /api/extension/whoami` — checks a pasted token. */
export interface ExtensionWhoami {
  email: string;
  deviceName: string | null;
}
