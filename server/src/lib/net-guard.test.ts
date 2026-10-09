import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

delete process.env.ALLOW_PRIVATE_TARGETS;
const { assertPublicUrl, BlockedTargetError, guardedFetch, guardedLookup, isPrivateAddress, setResolver } = await import("./net-guard.ts");
type TargetPolicy = import("./net-guard.ts").TargetPolicy;

const strict: TargetPolicy = { allowPrivate: false, allowHosts: [] };

describe("isPrivateAddress", () => {
  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "172.20.0.5",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "255.255.255.255",
    "::1",
    "::",
    "fe80::1%eth0",
    "fd12:3456::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "64:ff9b::a9fe:a9fe",
    "2002:c0a8:0101::1",
    "not-an-ip",
  ])("%s is private", (ip) => expect(isPrivateAddress(ip)).toBe(true));

  it.each(["93.184.216.34", "8.8.8.8", "172.32.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8", "[2a00:1450::1]"])("%s is public", (ip) => expect(isPrivateAddress(ip)).toBe(false));
});

describe("assertPublicUrl", () => {
  afterEach(() => setResolver(null));

  it("allows only http(s) without credentials", async () => {
    setResolver(async () => ["93.184.216.34"]);
    await expect(assertPublicUrl("https://shop.example/list", strict)).resolves.toBeInstanceOf(URL);
    for (const bad of ["file:///etc/passwd", "javascript:alert(1)", "chrome://version", "ftp://x.example/", "https://user:pw@shop.example/", "not a url"]) {
      await expect(assertPublicUrl(bad, strict), bad).rejects.toBeInstanceOf(BlockedTargetError);
    }
  });

  it("refuses private addresses, by literal or by what a name resolves to", async () => {
    setResolver(async (host) => (host === "rebind.example" ? ["93.184.216.34", "10.0.0.1"] : ["93.184.216.34"]));
    for (const url of ["http://127.0.0.1:3100/api/health", "http://169.254.169.254/latest/meta-data/", "http://[::1]/", "http://localhost/", "http://app.localhost/", "http://rebind.example/"]) {
      await expect(assertPublicUrl(url, strict), url).rejects.toThrow(/private or local network address/);
    }
  });

  it("lets allowed hosts and private-allowed policies through without resolving", async () => {
    setResolver(async () => {
      throw new Error("must not resolve");
    });
    await expect(assertPublicUrl("http://apprise:8000/notify/", { allowPrivate: false, allowHosts: ["apprise"] })).resolves.toBeInstanceOf(URL);
    await expect(assertPublicUrl("http://10.0.0.5/hook", { allowPrivate: true, allowHosts: [] })).resolves.toBeInstanceOf(URL);
    await expect(assertPublicUrl("https://nowhere.example/", strict)).rejects.toThrow("Can't resolve nowhere.example");
  });
});

describe("guardedLookup", () => {
  const lookup = (policy: TargetPolicy, all: boolean) =>
    new Promise<unknown>((resolve, reject) => guardedLookup(policy)("localhost", { all }, (err, address) => (err ? reject(err) : resolve(address))));

  it("refuses a private answer at connect time unless allowed", async () => {
    await expect(lookup(strict, true)).rejects.toBeInstanceOf(BlockedTargetError);
    await expect(lookup(strict, false)).rejects.toBeInstanceOf(BlockedTargetError);
    expect(await lookup({ allowPrivate: true, allowHosts: [] }, true)).toEqual(expect.arrayContaining([expect.objectContaining({ address: expect.any(String) })]));
    expect(typeof (await lookup({ allowPrivate: false, allowHosts: ["localhost"] }, false))).toBe("string");
  });
});

describe("guardedFetch", () => {
  let server: http.Server;
  let port = 0;
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.url === "/redirect") res.writeHead(302, { Location: "http://169.254.169.254/" }).end();
      else res.end("hello");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it("refuses private targets, by literal and by name", async () => {
    await expect(guardedFetch(`http://127.0.0.1:${port}/`, {}, strict)).rejects.toBeInstanceOf(BlockedTargetError);
    await expect(guardedFetch(`http://localhost:${port}/`, {}, strict)).rejects.toBeInstanceOf(BlockedTargetError);
  });

  it("reaches them when the policy allows, but never follows redirects", async () => {
    const open = { allowPrivate: true, allowHosts: [] };
    expect(await (await guardedFetch(`http://127.0.0.1:${port}/`, {}, open)).text()).toBe("hello");
    expect(await (await guardedFetch(`http://localhost:${port}/`, {}, { allowPrivate: false, allowHosts: ["localhost"] })).text()).toBe("hello");
    await expect(guardedFetch(`http://127.0.0.1:${port}/redirect`, {}, open)).rejects.toThrow("HTTP 302: redirects aren't followed");
  });
});
