/** A crawl the server crashed under this many times in a row is no longer continued on its own. */
export const MAX_CRASH_RESTARTS = 2;
/** How long a crawl that runs in the user's Chrome waits after a restart for their extension to reconnect. */
export const BROWSER_WAIT_MS = 2 * 60_000;

export type RestartAction = { kind: "resume" } | { kind: "wait-for-browser" } | { kind: "pause"; message: string };

/** What to do at startup with a crawl a restart cut off (crawler/job.ts resumeAfterRestart). */
export function restartAction(o: { crashRestarts: number; runner: "server" | "browser"; llmReady: boolean }): RestartAction {
  if (o.crashRestarts > MAX_CRASH_RESTARTS) {
    return { kind: "pause", message: `Stopped after the server crashed ${o.crashRestarts} times during this crawl — press Resume to try again` };
  }
  // Without a working key it would only stop again at the first page.
  if (!o.llmReady) return { kind: "pause", message: "Paused by a server update — add a working LLM key, then press Resume" };
  return o.runner === "browser" ? { kind: "wait-for-browser" } : { kind: "resume" };
}
