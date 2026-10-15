import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import type { JobEvent } from "@specharvest/shared";
import { publish, subscribe } from "./hub.ts";

/** Collects what the hub writes; enough of a ServerResponse for subscribe(). */
function fakeResponse() {
  const out: string[] = [];
  const res = Object.assign(new EventEmitter(), {
    writeHead: () => res,
    write: (chunk: string) => out.push(chunk),
    end: () => {},
  });
  return { res: res as unknown as ServerResponse, out, close: () => res.emit("close") };
}

const log = (message: string): JobEvent => ({ type: "log", message, level: "info" });
const ids = (out: string[]) => out.flatMap((c) => [...c.matchAll(/^id: (.+)$/gm)].map((m) => m[1]));
const messages = (out: string[]) => out.flatMap((c) => [...c.matchAll(/"message":"([^"]+)"/g)].map((m) => m[1]));

describe("SSE replay across restarts", () => {
  it("replays only newer events for an id from this process", () => {
    const channel = "test:same-boot";
    publish(channel, log("a"));
    publish(channel, log("b"));
    publish(channel, log("c"));
    const first = fakeResponse();
    subscribe(channel, first.res);
    first.close();
    const [, second] = ids(first.out);

    const again = fakeResponse();
    subscribe(channel, again.res, second);
    again.close();
    expect(messages(again.out)).toEqual(["c"]);
  });

  it("replays everything for an id from before a restart, even a smaller one", () => {
    const channel = "test:other-boot";
    for (const m of ["a", "b", "c"]) publish(channel, log(m));
    const res = fakeResponse();
    subscribe(channel, res.res, "oldboot-1");
    res.close();
    expect(messages(res.out)).toEqual(["a", "b", "c"]);
  });

  it("replays everything for a bare numeric id (from a server before boot ids)", () => {
    const channel = "test:legacy";
    for (const m of ["a", "b"]) publish(channel, log(m));
    const res = fakeResponse();
    subscribe(channel, res.res, "1");
    res.close();
    expect(messages(res.out)).toEqual(["a", "b"]);
  });
});
