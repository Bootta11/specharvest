import { describe, expect, it } from "vitest";
import { MAX_CRASH_RESTARTS, restartAction } from "./restart.ts";

describe("restartAction", () => {
  it("continues server crawls", () => {
    expect(restartAction({ crashRestarts: 0, runner: "server", llmReady: true })).toEqual({ kind: "resume" });
  });

  it("holds crawls that run in the user's browser until it reconnects", () => {
    expect(restartAction({ crashRestarts: 1, runner: "browser", llmReady: true })).toEqual({ kind: "wait-for-browser" });
  });

  it("keeps continuing up to the crash limit, then pauses", () => {
    expect(restartAction({ crashRestarts: MAX_CRASH_RESTARTS, runner: "server", llmReady: true }).kind).toBe("resume");
    const after = restartAction({ crashRestarts: MAX_CRASH_RESTARTS + 1, runner: "browser", llmReady: true });
    expect(after.kind).toBe("pause");
    expect(after.kind === "pause" && after.message).toContain(`crashed ${MAX_CRASH_RESTARTS + 1} times`);
  });

  it("pauses when the owner has no working LLM key", () => {
    const action = restartAction({ crashRestarts: 0, runner: "server", llmReady: false });
    expect(action.kind === "pause" && action.message).toContain("LLM key");
  });
});
