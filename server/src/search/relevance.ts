import type { Relevance } from "@specharvest/shared";

/** Within this much cosine similarity of the best match, and at least HIGH_MIN: high. */
export const HIGH_GAP = 0.08;
export const HIGH_MIN = 0.35;
/** Within this much of the best match, and at least MEDIUM_MIN: medium. Everything else is low (faded). */
export const MEDIUM_GAP = 0.18;
export const MEDIUM_MIN = 0.25;

/**
 * How well each item matches a meaning search: close to the best match *and* similar enough on its own. The floor
 * keeps a search with no real match (best similarity ~0.2–0.35, e.g. "phone" among laptops) from calling its least
 * bad items strong. A missing score is low.
 */
export function relevanceLevels(scores: Array<number | null | undefined>): Relevance[] {
  const known = scores.filter((s): s is number => typeof s === "number");
  if (known.length === 0) return scores.map(() => "low");
  const top = Math.max(...known);
  return scores.map((s) => {
    if (typeof s !== "number") return "low";
    if (s >= Math.max(HIGH_MIN, top - HIGH_GAP)) return "high";
    if (s >= Math.max(MEDIUM_MIN, top - MEDIUM_GAP)) return "medium";
    return "low";
  });
}
