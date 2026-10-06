import { describe, expect, it } from "vitest";
import { extractJson, salvageJson } from "./client.ts";

describe("extractJson", () => {
  it("parses fenced and chatty responses", () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('Sure! {"a":[1,2]} hope that helps')).toEqual({ a: [1, 2] });
  });

  it("repairs lone backslashes", () => {
    expect(extractJson('{"sel":".lg\\:w-1"}')).toEqual({ sel: ".lg\\:w-1" });
  });

  it("salvages a truncated spec list", () => {
    const broken = '{"title":"Car","specs":[["a",1,null],["b",true,null],["c","x';
    expect(extractJson(broken)).toEqual({ title: "Car", specs: [["a", 1, null], ["b", true, null]] });
  });
});

describe("salvageJson", () => {
  it("ignores brackets inside strings", () => {
    expect(salvageJson('{"t":"a ] b","l":[1,2],"z":"unterminated')).toEqual({ t: "a ] b", l: [1, 2] });
  });
});
