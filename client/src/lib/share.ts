import { storageGet, storageSet } from "./api.ts";

/**
 * A link shared into the Android app from another app (see MainActivity.java). It's kept in storage until the
 * Collections tab picks it up, so a share received on the sign-in screen survives signing in.
 */
export const SHARE_EVENT = "specharvest:share";

const KEY = "sharedLink";

export interface SharedLink {
  url: string;
  /** A title for the new collection, from the shared text or the URL; "" when nothing useful. */
  title: string;
}

/**
 * The first http(s) link in shared text, plus a title — apps often share "Title\nhttps://…" or
 * "Look at this: https://…". Without text around the link, the title comes from the URL.
 */
export function parseShared(text: string): SharedLink | null {
  const match = text.match(/https?:\/\/[^\s<>"]+/i);
  if (!match) return null;
  let url: string;
  try {
    url = new URL(match[0].replace(/[.,;:!?)\]}'»]+$/, "")).href;
  } catch {
    return null;
  }
  const rest = text
    .replace(match[0], " ")
    .replace(/\s+/g, " ")
    .replace(/^[\s\-–—|:·•]+|[\s\-–—|:·•(]+$/g, "");
  // "Look at this: https://…" is an intro, not the page's title.
  const intro = /:\s*$/.test(text.slice(0, match.index)) && !text.slice(match.index! + match[0].length).trim();
  return { url, title: (intro || !rest ? titleFromUrl(url) : rest).slice(0, 200) };
}

const SEARCH_PARAMS = ["q", "query", "search", "keyword", "keywords", "k", "term", "s"];

/** "…/category/road-bikes?sort=price" → "Road bikes"; "…/search?q=trail+bike" → "Trail bike". */
export function titleFromUrl(href: string): string {
  const url = new URL(href);
  const query = SEARCH_PARAMS.map((p) => url.searchParams.get(p)?.trim()).find(Boolean);
  const segment = url.pathname
    .split("/")
    .map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    })
    .map((s) => s.replace(/\.[a-z]{2,5}$/i, "").replace(/[-_+]+/g, " ").trim())
    // Skip ids, page numbers and generic words.
    .filter((s) => s && /[a-z]/i.test(s) && !/^(search|pretraga|category|categories|c|p|s|list|listing|products?|shop|index|page)$/i.test(s))
    .pop();
  const words = query ?? segment ?? "";
  return words ? words[0].toUpperCase() + words.slice(1) : "";
}

export function setPendingShare(link: SharedLink) {
  storageSet(KEY, JSON.stringify(link));
  window.dispatchEvent(new Event(SHARE_EVENT));
}

export function peekPendingShare(): SharedLink | null {
  try {
    const link = JSON.parse(storageGet(KEY) || "null") as SharedLink | null;
    return link?.url ? link : null;
  } catch {
    return null;
  }
}

export const hasPendingShare = () => !!peekPendingShare();

/** Clears the pending shared link once the Collections tab has shown it. */
export const clearPendingShare = () => storageSet(KEY, "");

/** For matching a shared link against collections' start URLs: no fragment, no trailing slash. */
export function sameUrl(a: string, b: string): boolean {
  const norm = (s: string) => {
    try {
      const u = new URL(s);
      u.hash = "";
      return u.href.replace(/\/+$/, "");
    } catch {
      return s.trim();
    }
  };
  return norm(a) === norm(b);
}
