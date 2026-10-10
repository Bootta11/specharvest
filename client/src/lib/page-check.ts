import { useEffect, useRef, useState } from "react";
import type { InspectResult } from "@specharvest/shared";
import { api } from "./api.ts";

export type PageCheck = { url: string; status: "checking" } | { url: string; status: "done"; result: InspectResult } | { url: string; status: "failed" };

const TIMEOUT_MS = 25_000;
const DEBOUNCE_MS = 600;

const validUrl = (s: string) => {
  try {
    return /^https?:$/.test(new URL(s).protocol);
  } catch {
    return false;
  }
};

/**
 * Checks what the URL in the crawl form is (listing / item / other) while it's typed or shared; null when
 * there's no valid URL or `enabled` is false. Typing is debounced; `immediate` (a shared link) isn't.
 */
export function usePageCheck(url: string, enabled: boolean, immediate?: string | null): PageCheck | null {
  const [check, setCheck] = useState<PageCheck | null>(null);
  const seq = useRef(0);
  const target = url.trim();

  useEffect(() => {
    const n = ++seq.current;
    if (!enabled || !validUrl(target)) {
      setCheck(null);
      return;
    }
    setCheck((c) => (c?.url === target && c.status !== "failed" ? c : { url: target, status: "checking" }));
    const timer = setTimeout(
      () => {
        const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), TIMEOUT_MS));
        Promise.race([api.inspectUrl(target), timeout]).then(
          (result) => n === seq.current && setCheck({ url: target, status: "done", result }),
          () => n === seq.current && setCheck({ url: target, status: "failed" }),
        );
      },
      target === immediate ? 0 : DEBOUNCE_MS,
    );
    return () => clearTimeout(timer);
  }, [target, enabled]); // eslint-disable-line react-hooks/exhaustive-deps

  return check;
}
