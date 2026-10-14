import type { BurstProvider, BurstServer } from "./provider.ts";

const API = "https://api.digitalocean.com/v2";
const TIMEOUT_MS = 15_000;

interface Droplet {
  id: number;
  name: string;
  status: string;
  created_at?: string;
  networks?: { v4?: Array<{ ip_address: string; type: string }> };
}

const toServer = (d: Droplet): BurstServer => ({
  id: String(d.id),
  name: d.name,
  ip: d.networks?.v4?.find((n) => n.type === "public")?.ip_address ?? null,
  active: d.status === "active",
  createdAt: d.created_at ? Date.parse(d.created_at) : null,
});

/** A saved droplet image (snapshot) that new droplets can start from. */
export interface Snapshot {
  id: string;
  name: string;
  createdAt: string;
  sizeGb: number;
}

/** What the image builder (scripts/burst-image.ts) needs beyond BurstProvider. */
export interface ImageBuilder {
  /** Shuts the droplet down and waits until it's off. */
  powerOff(id: string): Promise<void>;
  /** Saves the (powered-off) droplet as a snapshot named `name` and waits for it. */
  snapshot(id: string, name: string): Promise<Snapshot>;
  listSnapshots(): Promise<Snapshot[]>;
  deleteSnapshot(id: string): Promise<void>;
}

export interface DigitalOceanOptions {
  regions: Array<{ slug: string; name: string; available: boolean }>;
  sizes: Array<{ slug: string; description: string; priceHourly: number; regions: string[]; available: boolean }>;
}

export interface DigitalOceanProvider extends BurstProvider, ImageBuilder {
  options(): Promise<DigitalOceanOptions>;
  testScopes(): Promise<Record<string, { ok: boolean; error?: string }>>;
}

const ACTION_POLL_MS = 5_000;
const ACTION_TIMEOUT_MS = 20 * 60_000;

/** DigitalOcean droplets, through the plain REST API (https://docs.digitalocean.com/reference/api/). */
export function digitalOcean(o: {
  token: string;
  region: string;
  size: string;
  image: string;
  sshKeyId?: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}): DigitalOceanProvider {
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const doFetch = o.fetch ?? fetch;

  /** One API call; errors carry the status and DigitalOcean's message, never the token. */
  async function call<T>(method: string, path: string, body?: unknown, okMissing = false): Promise<T | null> {
    const res = await doFetch(API + path, {
      method,
      headers: { Authorization: `Bearer ${o.token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (okMissing && res.status === 404) return null;
    if (!res.ok) {
      const detail = await res
        .json()
        .then((j: { message?: string }) => j.message ?? "")
        .catch(() => "");
      throw new Error(`DigitalOcean ${method} ${path.split("?")[0]} → ${res.status}${detail ? `: ${detail}` : ""}`);
    }
    return res.status === 204 ? null : ((await res.json()) as T);
  }

  let price: number | null | undefined;

  /** Starts a droplet action and waits for it to complete. */
  async function action(id: string, body: Record<string, unknown>) {
    const r = await call<{ action: { id: number } }>("POST", `/droplets/${encodeURIComponent(id)}/actions`, body);
    const deadline = Date.now() + ACTION_TIMEOUT_MS;
    for (;;) {
      const a = await call<{ action: { status: string } }>("GET", `/actions/${r!.action.id}`);
      if (a!.action.status === "completed") return;
      if (a!.action.status === "errored") throw new Error(`DigitalOcean ${String(body.type)} failed`);
      if (Date.now() > deadline) throw new Error(`DigitalOcean ${String(body.type)} didn't finish in ${ACTION_TIMEOUT_MS / 60_000} min`);
      await sleep(ACTION_POLL_MS);
    }
  }

  const toSnapshot = (s: { id: string | number; name: string; created_at: string; size_gigabytes: number }): Snapshot => ({
    id: String(s.id),
    name: s.name,
    createdAt: s.created_at,
    sizeGb: s.size_gigabytes,
  });

  return {
    name: "digitalocean",

    async prepare({ tag, allowedIp, port }) {
      const name = `${tag}-firewall`;
      const body = {
        name,
        inbound_rules: [{ protocol: "tcp", ports: String(port), sources: { addresses: [allowedIp] } }],
        outbound_rules: [
          { protocol: "tcp", ports: "all", destinations: { addresses: ["0.0.0.0/0", "::/0"] } },
          { protocol: "udp", ports: "all", destinations: { addresses: ["0.0.0.0/0", "::/0"] } },
          { protocol: "icmp", destinations: { addresses: ["0.0.0.0/0", "::/0"] } },
        ],
        tags: [tag],
      };
      // A firewall can only name a tag that exists (a droplet would create it, but the firewall comes first).
      await call("POST", "/tags", { name: tag }).catch((err: Error) => {
        if (!/→ 422/.test(err.message)) throw err;
      });
      const list = await call<{ firewalls: Array<{ id: string; name: string }> }>("GET", "/firewalls?per_page=200");
      const existing = list?.firewalls.find((f) => f.name === name);
      // PUT replaces the rules, so a changed BURST_ALLOWED_IP takes effect.
      if (existing) await call("PUT", `/firewalls/${existing.id}`, body);
      else await call("POST", "/firewalls", body);
    },

    async create({ name, tag, userData, image }) {
      const r = await call<{ droplet: Droplet }>("POST", "/droplets", {
        name,
        region: o.region,
        size: o.size,
        // A snapshot is named by its numeric id, a DigitalOcean image by its slug.
        image: /^\d+$/.test(image ?? o.image) ? Number(image ?? o.image) : (image ?? o.image),
        user_data: userData,
        tags: [tag],
        ipv6: false,
        monitoring: false,
        with_droplet_agent: false,
        ...(o.sshKeyId ? { ssh_keys: [o.sshKeyId] } : {}),
      });
      return toServer(r!.droplet);
    },

    async get(id) {
      const r = await call<{ droplet: Droplet }>("GET", `/droplets/${encodeURIComponent(id)}`, undefined, true);
      return r ? toServer(r.droplet) : null;
    },

    async delete(id) {
      await call("DELETE", `/droplets/${encodeURIComponent(id)}`, undefined, true);
    },

    async list(tag) {
      const r = await call<{ droplets: Droplet[] }>("GET", `/droplets?tag_name=${encodeURIComponent(tag)}&per_page=200`);
      return (r?.droplets ?? []).map(toServer);
    },

    async powerOff(id) {
      await action(id, { type: "power_off" });
    },

    async snapshot(id, name) {
      await action(id, { type: "snapshot", name });
      const r = await call<{ snapshots: Array<{ id: string; name: string; created_at: string; size_gigabytes: number }> }>(
        "GET",
        `/droplets/${encodeURIComponent(id)}/snapshots?per_page=200`,
      );
      const snap = r?.snapshots.find((s) => s.name === name);
      if (!snap) throw new Error(`Snapshot ${name} not found after it was taken`);
      return toSnapshot(snap);
    },

    async listSnapshots() {
      const r = await call<{ snapshots: Array<{ id: string; name: string; created_at: string; size_gigabytes: number }> }>("GET", "/snapshots?resource_type=droplet&per_page=200");
      return (r?.snapshots ?? []).map(toSnapshot);
    },

    async deleteSnapshot(id) {
      await call("DELETE", `/snapshots/${encodeURIComponent(id)}`, undefined, true);
    },

    async options() {
      const [regions, sizes] = await Promise.all([
        call<{ regions: Array<{ slug: string; name: string; available: boolean }> }>("GET", "/regions?per_page=200"),
        call<{ sizes: Array<{ slug: string; description: string; price_hourly: number; regions: string[]; available: boolean }> }>("GET", "/sizes?per_page=200"),
      ]);
      return {
        regions: regions?.regions ?? [],
        sizes: (sizes?.sizes ?? []).map((size) => ({
          slug: size.slug,
          description: size.description,
          priceHourly: size.price_hourly,
          regions: size.regions,
          available: size.available,
        })),
      };
    },

    async testScopes() {
      const checks: Array<[string, string]> = [
        ["droplet:read", "/droplets?per_page=1"],
        ["firewall:read", "/firewalls?per_page=1"],
        ["sizes:read", "/sizes?per_page=1"],
        ["image:read", "/snapshots?resource_type=droplet&per_page=1"],
        ["actions:read", "/actions?per_page=1"],
        ["tag:read", "/tags?per_page=1"],
      ];
      return Object.fromEntries(
        await Promise.all(
          checks.map(async ([scope, path]) => {
            try {
              await call("GET", path);
              return [scope, { ok: true }] as const;
            } catch (err) {
              return [scope, { ok: false, error: (err as Error).message }] as const;
            }
          }),
        ),
      );
    },

    async hourlyPrice() {
      if (price !== undefined) return price;
      try {
        const r = await call<{ sizes: Array<{ slug: string; price_hourly: number }> }>("GET", "/sizes?per_page=200");
        price = r?.sizes.find((s) => s.slug === o.size)?.price_hourly ?? null;
      } catch {
        price = null;
      }
      return price;
    },
  };
}
