/**
 * Item URL patterns (CollectionDetection.itemUrlPattern) are compiled with `new RegExp` and run on every link
 * of every listing page — server-side too, where a catastrophic pattern would freeze the event loop. Only the
 * shapes our own generators produce are accepted (detect.ts inferItemUrlPattern / heuristic detection):
 * `^`, then escaped literal characters and `[^/?#]+` path segments, then optionally `(?:[/?#]|$)`.
 * Such patterns have no nested quantifiers or alternation, so matching is linear. Anything else — an
 * imported file, an older row — is dropped, and the listing falls back to the card selector (or re-detection).
 */
const SAFE_PATTERN = /^\^(?:\\[.*+?^${}()|[\]\\/]|\[\^\/\?#\]\+|[^.*+?^${}()|[\]\\])*(?:\(\?:\[\/\?#\]\|\$\))?$/;

export function isSafeItemUrlPattern(pattern: string): boolean {
  return pattern.length <= 1000 && SAFE_PATTERN.test(pattern);
}

/** The pattern when it's safe to compile, else null. */
export function safeItemUrlPattern(pattern: string | null | undefined): string | null {
  return pattern && isSafeItemUrlPattern(pattern) ? pattern : null;
}

/** A detection with an unsafe itemUrlPattern dropped (null stays null). */
export function withSafeUrlPattern<T extends { itemUrlPattern?: string | null }>(detection: T | null): T | null {
  if (!detection?.itemUrlPattern) return detection;
  return { ...detection, itemUrlPattern: safeItemUrlPattern(detection.itemUrlPattern) };
}
