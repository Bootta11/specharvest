import { describe, expect, it } from "vitest";
import { relevanceLevels } from "./relevance.ts";

describe("relevanceLevels", () => {
  it("grades each score by its distance from the best one", () => {
    expect(relevanceLevels([0.62, 0.58, 0.5, 0.3])).toEqual(["high", "high", "medium", "low"]);
  });

  it("calls nothing strong when even the best match is weak", () => {
    expect(relevanceLevels([0.21, 0.2, 0.12])).toEqual(["low", "low", "low"]);
    expect(relevanceLevels([0.31, 0.29, 0.2])).toEqual(["medium", "medium", "low"]);
  });

  it("marks a set of similar scores all high", () => {
    expect(relevanceLevels([0.51, 0.5, 0.49])).toEqual(["high", "high", "high"]);
  });

  it("never grades below the floors", () => {
    expect(relevanceLevels([0.4, 0.34, 0.26, 0.24])).toEqual(["high", "medium", "medium", "low"]);
  });

  it("treats missing scores as low and handles empty input", () => {
    expect(relevanceLevels([0.5, null, undefined])).toEqual(["high", "low", "low"]);
    expect(relevanceLevels([null])).toEqual(["low"]);
    expect(relevanceLevels([])).toEqual([]);
  });
});
