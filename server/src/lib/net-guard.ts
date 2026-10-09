import dns from "node:dns";
import https from "node:https";
import net, { type LookupFunction } from "node:net";
import { Agent, fetch as undiciFetch, type Response } from "undici";
import { env } from "../config.ts";

/**
 * Outbound requests to user-supplied URLs (crawls, notification webhooks, Web Push endpoints) must not reach
 * the server's own networks: loopback, private LAN ranges, link-local (cloud metadata at 169.254.169.254),
 * CGNAT, … A host name counts by what it resolves to. Connections made through guardedFetch /
 * guardedHttpsAgent check the address actually connected to, so a DNS answer that changes between the check
 * and the request (rebinding) can't slip through. The browser resolves names itself — see crawler/browser.ts.
 */

// ---------- Addresses ----------

const V4_BLOCKED: Array<[string, number]> = [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // CGNAT
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // link-local, cloud metadata
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved + broadcast
];
const V6_BLOCKED: Array<[string, number]> = [
  ["::", 128],
  ["::1", 128],
  ["100::", 64], // discard
  ["2001:db8::", 32], // documentation
  ["fc00::", 7], // unique local
  ["fe80::", 10], // link-local
  ["ff00::", 8], // multicast
];

const v4Blocked = new net.BlockList();
for (const [address, prefix] of V4_BLOCKED) v4Blocked.addSubnet(address, prefix, "ipv4");
const v6Blocked = new net.BlockList();
for (const [address, prefix] of V6_BLOCKED) v6Blocked.addSubnet(address, prefix, "ipv6");

/** The eight 16-bit groups of a valid IPv6 address. */
function ipv6Groups(ip: string): number[] {
  let s = ip.toLowerCase();
  const tail: number[] = [];
  const dotted = s.match(/(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number);
    tail.push((a << 8) | b, (c << 8) | d);
    s = s.slice(0, -dotted[0].length);
    if (!s.endsWith("::")) s = s.slice(0, -1); // the ":" before the dotted part
  }
  const want = 8 - tail.length;
  const [head, rest] = s.split("::");
  const parse = (part: string | undefined) => (part ? part.split(":").map((g) => parseInt(g, 16)) : []);
  const h = parse(head);
  if (rest === undefined) return [...h, ...tail];
  const r = parse(rest);
  return [...h, ...new Array(want - h.length - r.length).fill(0), ...r, ...tail];
}

/** IPv4 carried inside an IPv6 address: v4-mapped/-compatible (::ffff:a.b.c.d), NAT64 (64:ff9b::/96), 6to4 (2002::/16). */
function embeddedV4(g: number[]): string | null {
  const v4 = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  const zeros = (from: number, to: number) => g.slice(from, to).every((x) => x === 0);
  if (zeros(0, 5) && (g[5] === 0xffff || g[5] === 0)) return v4(g[6], g[7]);
  if (g[0] === 0x64 && g[1] === 0xff9b && zeros(2, 6)) return v4(g[6], g[7]);
  if (g[0] === 0x2002) return v4(g[1], g[2]);
  return null;
}

/** True for anything that isn't a public unicast address (and for anything that isn't an IP at all). */
export function isPrivateAddress(ip: string): boolean {
  const address = ip.replace(/^\[|\]$/g, "").split("%")[0];
  if (net.isIPv4(address)) return v4Blocked.check(address, "ipv4");
  if (!net.isIPv6(address)) return true;
  const inner = embeddedV4(ipv6Groups(address));
  return inner ? v4Blocked.check(inner, "ipv4") : v6Blocked.check(address, "ipv6");
}

// ---------- Policy ----------

export interface TargetPolicy {
  /** Private/LAN addresses are fine too (admins' notification targets, ALLOW_PRIVATE_TARGETS). */
  allowPrivate: boolean;
  /** Host names that may be private anyway (OUTBOUND_ALLOWED_HOSTS, e.g. the bundled Apprise container). */
  allowHosts: readonly string[];
}

/** Crawls and Web Push endpoints: public hosts only (unless ALLOW_PRIVATE_TARGETS). */
export const strictPolicy = (): TargetPolicy => ({ allowPrivate: env.ALLOW_PRIVATE_TARGETS, allowHosts: [] });

/** Notification targets: admins may use any address; everyone else public hosts plus OUTBOUND_ALLOWED_HOSTS. */
export const notifyPolicy = (user: { role: string } | null | undefined): TargetPolicy => ({
  allowPrivate: env.ALLOW_PRIVATE_TARGETS || user?.role === "admin",
  allowHosts: env.OUTBOUND_ALLOWED_HOSTS,
});

const hostAllowed = (policy: TargetPolicy, host: string) => policy.allowPrivate || policy.allowHosts.includes(host.toLowerCase());

/** A user-facing refusal (400): not http(s), credentials in the URL, or a private/local address. */
export class BlockedTargetError extends Error {
  readonly statusCode = 400;
  readonly code = "EBLOCKEDTARGET";
}

const privateHost = (host: string) => new BlockedTargetError(`${host} is a private or local network address`);

// ---------- Checks ----------

type Resolver = (hostname: string) => Promise<string[]>;
const systemResolver: Resolver = async (hostname) => (await dns.promises.lookup(hostname, { all: true, verbatim: true })).map((a) => a.address);
let resolver = systemResolver;

/** Test hook: answer host lookups of assertPublicUrl/isPublicHost without DNS (null = the system resolver). */
export function setResolver(fn: Resolver | null) {
  resolver = fn ?? systemResolver;
}

/** Hostname without IPv6 brackets. */
const bareHost = (url: URL) => url.hostname.replace(/^\[|\]$/g, "");

/** Throws BlockedTargetError unless `host` may be reached under `policy` (resolving names). */
async function assertPublicHost(host: string, policy: TargetPolicy): Promise<void> {
  if (hostAllowed(policy, host)) return;
  if (net.isIP(host)) {
    if (isPrivateAddress(host)) throw privateHost(host);
    return;
  }
  if (host === "localhost" || host.endsWith(".localhost")) throw privateHost(host);
  let addresses: string[];
  try {
    addresses = await resolver(host);
  } catch {
    throw new BlockedTargetError(`Can't resolve ${host}`);
  }
  if (addresses.length === 0 || addresses.some(isPrivateAddress)) throw privateHost(host);
}

/** The parsed URL when it's an http(s) URL without credentials whose host may be reached; else BlockedTargetError. */
export async function assertPublicUrl(raw: string, policy: TargetPolicy): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BlockedTargetError(`Not a valid URL: ${raw.slice(0, 100)}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new BlockedTargetError("Only http:// and https:// addresses are allowed");
  if (url.username || url.password) throw new BlockedTargetError("Addresses with a user name or password in them aren't allowed");
  await assertPublicHost(bareHost(url), policy);
  return url;
}

/** Boolean form for the browser's request filter (unresolvable counts as not allowed). */
export function isPublicHost(host: string, policy: TargetPolicy): Promise<boolean> {
  return assertPublicHost(host.replace(/^\[|\]$/g, ""), policy).then(
    () => true,
    () => false,
  );
}

// ---------- Guarded connections ----------

/**
 * dns.lookup that refuses private answers (unless allowed) — passed to net/tls connect, so the check is on the
 * address the socket really connects to. Node skips `lookup` for IP literals: callers check those first.
 */
export function guardedLookup(policy: TargetPolicy): LookupFunction {
  return (hostname, options, callback) => {
    dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
      const done = callback as (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void;
      if (err) return done(err, options.all ? [] : "");
      if (!hostAllowed(policy, hostname) && (addresses.length === 0 || addresses.some((a) => isPrivateAddress(a.address)))) {
        return done(privateHost(hostname) as unknown as NodeJS.ErrnoException, options.all ? [] : "");
      }
      if (options.all) done(null, addresses);
      else done(null, addresses[0].address, addresses[0].family);
    });
  };
}

const policyKey = (policy: TargetPolicy) => `${policy.allowPrivate ? 1 : 0}:${policy.allowHosts.join(",")}`;
const dispatchers = new Map<string, Agent>();
const httpsAgents = new Map<string, https.Agent>();

function dispatcherFor(policy: TargetPolicy): Agent {
  const key = policyKey(policy);
  let agent = dispatchers.get(key);
  if (!agent) dispatchers.set(key, (agent = new Agent({ connect: { lookup: guardedLookup(policy) } })));
  return agent;
}

/** https.Agent for libraries that take one (web-push): every connection goes through guardedLookup. */
export function guardedHttpsAgent(policy: TargetPolicy): https.Agent {
  const key = policyKey(policy);
  let agent = httpsAgents.get(key);
  if (!agent) httpsAgents.set(key, (agent = new https.Agent({ keepAlive: true, lookup: guardedLookup(policy) })));
  return agent;
}

export interface GuardedRequestInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

/**
 * fetch for user-supplied URLs: http(s) only, private addresses refused per `policy` (also at connect time),
 * redirects not followed — a public URL answering 302 to an internal one would otherwise get around the check.
 */
export async function guardedFetch(url: string, init: GuardedRequestInit, policy: TargetPolicy): Promise<Response> {
  await assertPublicUrl(url, policy);
  let res: Response;
  try {
    res = await undiciFetch(url, { ...init, redirect: "manual", dispatcher: dispatcherFor(policy) });
  } catch (err) {
    // undici reports every network failure as "fetch failed" — the cause says what happened (refused, ENOTFOUND, blocked).
    const cause = (err as { cause?: unknown }).cause;
    throw cause instanceof Error ? cause : err;
  }
  if (res.status >= 300 && res.status < 400) {
    await res.body?.cancel().catch(() => {});
    throw new Error(`HTTP ${res.status}: redirects aren't followed — use the final URL`);
  }
  return res;
}
