import { createHash } from "node:crypto";

/**
 * Lines that change on every visit without the listing itself changing:
 * relative times, view counters, "published/renewed <date>" stamps. They are
 * dropped before hashing so they don't trigger a re-extraction. Prices and
 * spec numbers stay, so a real change still changes the fingerprint.
 */
const VOLATILE_LINE: RegExp[] = [
  // Relative times: "2 hours ago", "prije 3 dana", "vor 5 Minuten", "just now", "danas u 14:05"
  /\b(\d+|an?|one)\s+(sec(ond)?s?|min(ute)?s?|hours?|hrs?|days?|weeks?|months?|years?)\s+ago\b/i,
  /\bprije\s+(\d+|par|nekoliko|jedan|jednog|jedne)?\s*(sek|min|sat|sati|sata|dan|dana|sedmic|tjed|nedelj|mjesec|mesec|godin)/i,
  /\bvor\s+\d+\s+(sekunden|minuten|stunden?|tagen?|wochen?|monaten?|jahren?)\b/i,
  /^\s*(just now|upravo( sada)?|maloprije|danas|jučer|jucer|juče|juce|today|yesterday|heute|gestern)\b/i,
  // View / favourite counters: "123 views", "Pregleda: 456", "1.234 pregleda"
  /\b(views?|viewed|pregleda|pregledi|aufrufe|favorites?|favourites?|praćenja|pracenja|followers?)\b/i,
  // Renew stamps and seller activity ("Obnovljen 06.10.2026", "Online prije 3 sata", "Prosječno vrijeme odgovora 2 sata")
  /\b(updated|renewed|refreshed|bumped|obnovljen[oa]?|osvježen[oa]?|osvjezen[oa]?|ažuriran[oa]?|azuriran[oa]?|aktualisiert|last seen|zuletzt online|vrijeme odgovora|response time)\b/i,
  // Lazy-loaded Q&A / comment counters ("Pitanja (0)")
  /^(pitanja|questions|komentari|comments|fragen)\s*(\(\d+\))?$/i,
  // Section headings that come and go with promoted / other listings
  /^(izdvojeno|istaknuto|featured|sponsored|promoted|gesponsert|ostali oglasi( korisnika)?|slični oglasi|slicni oglasi|similar (ads|items|listings|products)|more from (this )?seller|you may also like)\b/i,
  // Price-rating badges computed by the site, not stated by the seller
  /^(realna|dobra|odlična|odlicna|visoka|niska|povoljna) cijena$|^(good|fair|great|high) (price|deal)$/i,
];

/**
 * Labels whose *next* line holds the changing value on label/value pages
 * ("Broj pregleda" / "9075", "Obnovljen" / "06.10.2026 u 14:52").
 */
const VOLATILE_LABEL = /^(broj pregleda|pregleda|pregledi|views?|aufrufe|obnovljen[oa]?|osvježen[oa]?|osvjezen[oa]?|ažurirano|azurirano|updated|renewed|last updated|aktualisiert)\s*:?$/i;
/** A short value line made of digits, dates and times ("9075", "06.10.2026 u 14:52"). */
const VALUE_LINE = /^[\d\s.,:/-]+(u|at|um)?[\d\s.,:/-]*h?$/i;

export function isVolatileLine(line: string): boolean {
  return line.length <= 120 && VOLATILE_LINE.some((re) => re.test(line));
}

/** Text with whitespace collapsed per line, blank and volatile lines dropped. */
export function normalizeForHash(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (VOLATILE_LABEL.test(l)) {
      if (lines[i + 1] && lines[i + 1].length <= 40 && VALUE_LINE.test(lines[i + 1])) i++;
      continue;
    }
    if (!isVolatileLine(l)) out.push(l);
  }
  return out.join("\n");
}

/**
 * Unique lowercase words/numbers of the normalized text. Hashing this set
 * instead of exact lines ignores layout jitter between renders: line
 * wrapping, casing, a breadcrumb rendered once or twice, section order.
 * Any new or removed value (a new price, an added feature) still changes it.
 */
export function contentTokens(text: string): string[] {
  const words = normalizeForHash(text)
    .toLowerCase()
    .split(/[^\p{L}\p{N}.,]+/u)
    .map((w) => w.replace(/^[.,]+|[.,]+$/g, ""))
    .filter(Boolean);
  return [...new Set(words)].sort();
}

export function fingerprint(text: string): string {
  return createHash("sha256").update(contentTokens(text).join(" ")).digest("hex");
}

/** A few removed/added words, for job logs ("- 25.900", "+ 24.500"). */
export function changedTokens(oldText: string, newText: string, max = 6): string[] {
  const a = contentTokens(oldText);
  const b = contentTokens(newText);
  const inA = new Set(a);
  const inB = new Set(b);
  return [...a.filter((t) => !inB.has(t)).map((t) => `- ${t}`), ...b.filter((t) => !inA.has(t)).map((t) => `+ ${t}`)].slice(0, max);
}

/** Share of the old text's words missing from the new text (0..1). A big drop usually means a half-rendered page. */
export function removedShare(oldText: string, newText: string): number {
  const a = contentTokens(oldText);
  if (a.length === 0) return 0;
  const inB = new Set(contentTokens(newText));
  return a.filter((t) => !inB.has(t)).length / a.length;
}
