/**
 * The crawl only opens public web pages: a crawled page could link to the user's router, NAS or anything on
 * their network, and whatever the tab shows goes to the SpecHarvest server. The server checks the same
 * before it sends a URL (lib/net-guard.ts); this is the extension's own line, by name and IP literal (the
 * extension can't resolve DNS, so a public name pointing at a LAN address isn't caught here).
 */

const PRIVATE_SUFFIXES = [".local", ".localhost", ".internal", ".lan", ".home", ".home.arpa", ".corp", ".intranet"];

function privateIPv4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function privateIPv6(host: string): boolean {
  if (!host.startsWith("[")) return false;
  const h = host.slice(1, -1).toLowerCase();
  return h === "::" || h === "::1" || /^f[cd]/.test(h) || /^fe[89ab]/.test(h) || h.startsWith("::ffff:");
}

/** Why `url` may not be crawled, or null when it may. */
export function blockedReason(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "Not a valid URL";
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return "Only http(s) pages can be crawled";
  const host = u.hostname.toLowerCase();
  if (host === "localhost" || (!host.includes(".") && !host.startsWith("["))) return "Local addresses can't be crawled";
  if (PRIVATE_SUFFIXES.some((s) => host.endsWith(s))) return "Local network addresses can't be crawled";
  if (privateIPv4(host) || privateIPv6(host)) return "Private network addresses can't be crawled";
  return null;
}

/** The site a host belongs to for permissions: www. dropped, so www.olx.ba and olx.ba are one site. */
export const siteOf = (host: string) => host.toLowerCase().replace(/^www\./, "");

/**
 * Host permission patterns that cover a site and its subdomains: for both http and https (what we ask for),
 * or only `url`'s own scheme (what a page load needs — access granted in Chrome's site settings may be https only).
 * Schemes are spelled out: Chrome refuses `*://` because the manifest declares http and https separately.
 */
export function originPatterns(url: string, scheme: "any" | "own" = "any"): string[] {
  const u = new URL(url);
  const site = siteOf(u.hostname);
  const schemes = scheme === "any" ? ["https", "http"] : [u.protocol.slice(0, -1)];
  return schemes.flatMap((s) => [`${s}://${site}/*`, `${s}://*.${site}/*`]);
}
