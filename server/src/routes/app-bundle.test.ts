import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "specharvest-app-bundle-"));
process.env.DATA_DIR = dataDir;

const { default: Fastify } = await import("fastify");
const { registerAuth } = await import("../auth/plugin.ts");
const { registerAppBundleRoutes } = await import("./app-bundle.ts");

afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }));

const zip = Buffer.from("PK fake zip");
const checksum = createHash("sha256").update(zip).digest("hex");

/** A server whose bundle dir holds the given files. */
async function server(files: Record<string, string | Buffer>) {
  const dir = fs.mkdtempSync(path.join(dataDir, "bundle-"));
  for (const [name, data] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), data);
  const app = Fastify();
  await registerAuth(app);
  registerAppBundleRoutes(app, dir);
  await app.ready();
  return app;
}

describe("app bundle routes", () => {
  it("answers 404 when the build has no bundle (dev)", async () => {
    const app = await server({});
    expect((await app.inject("/api/app/bundle")).statusCode).toBe(404);
    expect((await app.inject("/api/app/bundle.zip")).statusCode).toBe(404);
  });

  it("serves the manifest without signing in, never cached", async () => {
    const meta = { version: "abc123", checksum, minVersionCode: 7, signature: "c2ln" };
    const app = await server({ "dist-app.zip": zip, "dist-app.json": JSON.stringify(meta) });
    const res = await app.inject("/api/app/bundle");
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.json()).toEqual({ ...meta, url: "/api/app/bundle.zip?v=abc123" });
  });

  it("reports an unsigned bundle as signature: null", async () => {
    const app = await server({ "dist-app.zip": zip, "dist-app.json": JSON.stringify({ version: "dev", checksum, minVersionCode: 1 }) });
    expect((await app.inject("/api/app/bundle")).json().signature).toBeNull();
  });

  it("downloads the zip that matches the checksum", async () => {
    const meta = { version: "abc123", checksum, minVersionCode: 1, signature: null };
    const app = await server({ "dist-app.zip": zip, "dist-app.json": JSON.stringify(meta) });
    const res = await app.inject("/api/app/bundle.zip?v=abc123");
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/zip");
    expect(createHash("sha256").update(res.rawPayload).digest("hex")).toBe(checksum);
  });
});
