import { describe, expect, it, vi } from "vitest";
import { digitalOcean } from "./digitalocean.ts";
import { burstUserData, imageUserData } from "./provider.ts";

const TOKEN = "dop_v1_secret";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function setup(responses: Array<Response>) {
  const calls: Array<{ method: string; url: string; body: unknown; auth: string | null }> = [];
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      method: init?.method ?? "GET",
      url: String(url),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      auth: new Headers(init?.headers).get("Authorization"),
    });
    return responses.shift() ?? json({});
  });
  const provider = digitalOcean({ token: TOKEN, region: "fra1", size: "s-4vcpu-8gb", image: "debian-13-x64", fetch: fetchMock as unknown as typeof fetch });
  return { provider, calls };
}

describe("DigitalOcean provider", () => {
  it("creates a tagged droplet with the boot script and reads its public IP", async () => {
    const { provider, calls } = setup([
      json({ droplet: { id: 42, name: "specharvest-burst-1", status: "new" } }, 202),
      json({ droplet: { id: 42, name: "specharvest-burst-1", status: "active", networks: { v4: [{ ip_address: "10.0.0.2", type: "private" }, { ip_address: "203.0.113.7", type: "public" }] } } }),
    ]);
    const userData = burstUserData("ab".repeat(24));
    const created = await provider.create({ name: "specharvest-burst-1", tag: "specharvest-burst", userData });
    expect(created).toEqual({ id: "42", name: "specharvest-burst-1", ip: null, active: false, createdAt: null });
    expect(calls[0]).toMatchObject({
      method: "POST",
      url: "https://api.digitalocean.com/v2/droplets",
      auth: `Bearer ${TOKEN}`,
      body: { region: "fra1", size: "s-4vcpu-8gb", image: "debian-13-x64", tags: ["specharvest-burst"], user_data: userData },
    });
    expect(await provider.get("42")).toEqual({ id: "42", name: "specharvest-burst-1", ip: "203.0.113.7", active: true, createdAt: null });
  });

  it("lets only the allowed IP reach the browser port, updating an existing firewall", async () => {
    const { provider, calls } = setup([
      json({ tag: { name: "specharvest-burst" } }, 201),
      json({ firewalls: [] }),
      json({}, 202),
      json({ id: "unprocessable_entity", message: "tag already exists" }, 422),
      json({ firewalls: [{ id: "fw1", name: "specharvest-burst-firewall" }] }),
      json({}),
    ]);
    await provider.prepare({ tag: "specharvest-burst", allowedIp: "198.51.100.1", port: 9223 });
    expect(calls[0]).toMatchObject({ method: "POST", url: "https://api.digitalocean.com/v2/tags", body: { name: "specharvest-burst" } });
    expect(calls[2]).toMatchObject({
      method: "POST",
      url: "https://api.digitalocean.com/v2/firewalls",
      body: { name: "specharvest-burst-firewall", tags: ["specharvest-burst"], inbound_rules: [{ protocol: "tcp", ports: "9223", sources: { addresses: ["198.51.100.1"] } }] },
    });
    await provider.prepare({ tag: "specharvest-burst", allowedIp: "198.51.100.2", port: 9223 });
    expect(calls[5]).toMatchObject({ method: "PUT", url: "https://api.digitalocean.com/v2/firewalls/fw1" });
  });

  it("treats a droplet that's already gone as deleted, and never puts the token in errors", async () => {
    const { provider } = setup([new Response(null, { status: 404 }), json({ id: "unauthorized", message: "Unable to authenticate you" }, 401)]);
    await expect(provider.delete("42")).resolves.toBeUndefined();
    const err = await provider.list("specharvest-burst").catch((e: Error) => e);
    expect(String(err)).toContain("401: Unable to authenticate you");
    expect(String(err)).not.toContain(TOKEN);
  });

  it("reads the hourly price of the configured size once", async () => {
    const { provider, calls } = setup([json({ sizes: [{ slug: "s-1vcpu-1gb", price_hourly: 0.009 }, { slug: "s-4vcpu-8gb", price_hourly: 0.07143 }] })]);
    expect(await provider.hourlyPrice()).toBe(0.07143);
    expect(await provider.hourlyPrice()).toBe(0.07143);
    expect(calls).toHaveLength(1);
  });
});

describe("DigitalOcean image builder", () => {
  it("powers off, snapshots, waits for each action and finds the snapshot", async () => {
    const { calls, provider } = (() => {
      const responses = [
        json({ action: { id: 1, status: "in-progress" } }, 201),
        json({ action: { status: "in-progress" } }),
        json({ action: { status: "completed" } }),
        json({ action: { id: 2, status: "in-progress" } }, 201),
        json({ action: { status: "completed" } }),
        json({ snapshots: [{ id: "9001", name: "specharvest-browser-202610132045", created_at: "2026-10-13T20:50:00Z", size_gigabytes: 2.4 }] }),
      ];
      const calls: Array<{ method: string; url: string; body: unknown }> = [];
      const fetchMock = async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ method: init?.method ?? "GET", url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
        return responses.shift()!;
      };
      const provider = digitalOcean({ token: TOKEN, region: "fra1", size: "s-4vcpu-8gb", image: "debian-13-x64", fetch: fetchMock as typeof fetch, sleep: async () => {} });
      return { calls, provider };
    })();
    await provider.powerOff("42");
    const snap = await provider.snapshot("42", "specharvest-browser-202610132045");
    expect(snap).toEqual({ id: "9001", name: "specharvest-browser-202610132045", createdAt: "2026-10-13T20:50:00Z", sizeGb: 2.4 });
    expect(calls.map((c) => `${c.method} ${c.url.replace("https://api.digitalocean.com/v2", "")}`)).toEqual([
      "POST /droplets/42/actions",
      "GET /actions/1",
      "GET /actions/1",
      "POST /droplets/42/actions",
      "GET /actions/2",
      "GET /droplets/42/snapshots?per_page=200",
    ]);
    expect(calls[3]!.body).toEqual({ type: "snapshot", name: "specharvest-browser-202610132045" });
  });

  it("starts droplets from a snapshot id as a number", async () => {
    const { provider, calls } = (() => {
      const calls: Array<{ body: unknown }> = [];
      const fetchMock = async (_url: string | URL | Request, init?: RequestInit) => {
        calls.push({ body: init?.body ? JSON.parse(String(init.body)) : undefined });
        return json({ droplet: { id: 1, name: "x", status: "new" } }, 202);
      };
      return { calls, provider: digitalOcean({ token: TOKEN, region: "fra1", size: "s-4vcpu-8gb", image: "9001", fetch: fetchMock as typeof fetch }) };
    })();
    await provider.create({ name: "x", tag: "t", userData: "#!/bin/bash" });
    expect(calls[0]!.body).toMatchObject({ image: 9001 });
  });
});

describe("burstUserData", () => {
  it("serves the browser only under the token path", () => {
    const script = burstUserData("cd".repeat(24));
    expect(script).toContain(`handle_path /${"cd".repeat(24)}/*`);
    expect(script).toContain("--remote-debugging-address=127.0.0.1");
    expect(script).toContain("respond 403");
    expect(() => burstUserData("not hex; rm -rf /")).toThrow();
  });

  it("installs only when the image doesn't have the browser yet", () => {
    const script = burstUserData("cd".repeat(24));
    expect(script).toMatch(/if ! command -v chromium[^\n]*then\n[\s\S]*apt-get install[\s\S]*\nfi\n/);
  });
});

describe("imageUserData", () => {
  it("leaves no token or enabled browser in the image, only the ready marker", () => {
    const script = imageUserData();
    expect(script).toContain("apt-get upgrade");
    expect(script).toContain('respond /image-ready "ok" 200');
    expect(script).not.toContain("reverse_proxy");
    expect(script).not.toContain("enable --now crawl-browser");
    expect(script).toContain("rm -rf /tmp/chromium-check /home/crawler/profile");
  });
});
