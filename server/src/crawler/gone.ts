import { FatalDriverError, type PageDriver } from "./driver.ts";
import { gotoAndSettle, HttpStatusError } from "./browser.ts";
import { normalizeItemUrl } from "./paginate.ts";

/** Pages opened to tell a moved/emptied shop from a listing walk that went wrong. */
export const PROBE_SAMPLE = 8;
/** Dead pages it takes before the missing items count as gone (all of them when fewer are missing). */
const MIN_DEAD = 5;

/** What a missing item's own page says: it no longer exists, it's still there, or nothing to go by. */
export type ProbeResult = "dead" | "alive" | "unknown";

/** Up to `n` of `urls`, picked at random. */
export function sampleUrls(urls: readonly string[], n: number): string[] {
  const pool = [...urls];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, n);
}

/**
 * Opens a missing item's page. Dead: 404/410, or a redirect to an item this walk found (the product moved).
 * Alive: a page at its own address. Anything else (blocked, server error, redirect elsewhere) proves nothing.
 */
export async function probeItem(page: PageDriver, url: string, seen: { has(url: string): boolean }): Promise<ProbeResult> {
  try {
    await gotoAndSettle(page, url, { scroll: false });
    const finalUrl = normalizeItemUrl((await page.run("pageInfo")).url);
    if (finalUrl === normalizeItemUrl(url)) return "alive";
    return seen.has(finalUrl) ? "dead" : "unknown";
  } catch (err) {
    if (err instanceof FatalDriverError) throw err;
    return err instanceof HttpStatusError && (err.status === 404 || err.status === 410) ? "dead" : "unknown";
  }
}

/** Whether the probed sample proves the missing items are gone: none still there, and enough of them dead. */
export function confirmsGone(results: readonly ProbeResult[], missingCount: number): boolean {
  if (results.includes("alive")) return false;
  const dead = results.filter((r) => r === "dead").length;
  return dead > 0 && dead >= Math.min(MIN_DEAD, missingCount);
}
