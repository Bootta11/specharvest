import { describe, expect, it } from "vitest";
import { withLlmContext } from "../llm/usage.ts";
import { addTiming, finishJobTiming, notePagePhase, startJobTiming, takePagePhases, timed } from "./timing.ts";

describe("job timing", () => {
  it("sums page, LLM and embedding time per job into one summary line", async () => {
    startJobTiming(7);
    await withLlmContext({ jobId: 7 }, async () => {
      const page = {};
      notePagePhase(page, "goto", 1200);
      notePagePhase(page, "settle", 800);
      expect(takePagePhases(page).phases).toEqual({ goto: 1200, settle: 800 });
      addTiming("page.wait", 30_000);
      addTiming("page.work", 2000);
      addTiming("page.open", 900);
      addTiming("page.open.context", 100);
      addTiming("page.open.newPage", 600);
      addTiming("page.open.setup", 200);
      addTiming("page.filter", 40, 25);
      addTiming("page.trackers", 0, 9);
      addTiming("page.prefetches", 0, 150);
      addTiming("llm.extract", 4000);
      addTiming("llm.extract", 2000);
      await timed("embed", async () => {});
    });
    const summary = finishJobTiming(7)!;
    expect(summary).toContain("1 pages: waited for a free browser page 30s (avg 30s)");
    expect(summary).toContain("opening 900ms (avg 900ms: context 100ms, new page 600ms, setup 200ms)");
    expect(summary).toContain("loading 2.0s (avg 2.0s: goto 1.2s, text settle 800ms), request checks 40ms (25 requests, 9 trackers + 150 prefetches blocked)");
    expect(summary).toContain("LLM 2 calls 6.0s (extract 2× 6.0s)");
    expect(summary).toContain("embedding");
    // Forgotten once reported.
    expect(finishJobTiming(7)).toBeNull();
  });

  it("ignores timings outside a job", () => {
    startJobTiming(8);
    addTiming("llm.detect", 1000);
    expect(finishJobTiming(8)).toBeNull();
  });
});
