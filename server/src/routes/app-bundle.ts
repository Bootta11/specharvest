import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { userLimit } from "../auth/plugin.ts";

/**
 * The Android app's live UI update (docs/app-updates.md): the image ships the app's web UI built from the same
 * commit as this server, packed and signed by scripts/app-bundle.mjs. Both routes are public (the app also
 * updates on the sign-in screen); the app applies the bundle only if its signature checks out.
 */

export interface AppBundleManifest {
  version: string;
  /** Relative to the server; the app resolves it against the server's URL. */
  url: string;
  /** sha256 of the zip, hex. */
  checksum: string;
  /** The oldest APK versionCode whose native code this UI works with (client/native-baseline.json). */
  minVersionCode: number;
  /** ECDSA P-256 over "version\nchecksum\nminVersionCode", base64; null when the build had no signing key. */
  signature: string | null;
}

const DEFAULT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../client");

/** `dir` holds dist-app.zip and dist-app.json; without them (dev) both routes answer 404. Read once, at startup. */
export function registerAppBundleRoutes(app: FastifyInstance, dir = DEFAULT_DIR) {
  const zipPath = path.join(dir, "dist-app.zip");
  let manifest: AppBundleManifest | null = null;
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(dir, "dist-app.json"), "utf8")) as Omit<AppBundleManifest, "url">;
    if (fs.existsSync(zipPath)) {
      manifest = { ...meta, url: `/api/app/bundle.zip?v=${encodeURIComponent(meta.version)}`, signature: meta.signature ?? null };
    }
  } catch {
    /* no bundle in this build */
  }

  app.get("/api/app/bundle", async (_req, reply) => {
    reply.header("Cache-Control", "no-store");
    if (!manifest) return reply.status(404).send({ error: "No app bundle in this build" });
    return manifest;
  });

  app.get("/api/app/bundle.zip", userLimit(30), async (_req, reply) => {
    if (!manifest) return reply.status(404).send({ error: "No app bundle in this build" });
    return reply
      .header("Cache-Control", "no-store")
      .type("application/zip")
      .send(fs.createReadStream(zipPath));
  });
}
