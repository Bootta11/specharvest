#!/usr/bin/env node
// Packs the Android app's web UI (vite build --mode app) as a live-update bundle the server hands out at
// /api/app/bundle (see docs/app-updates.md). Writes <out>.zip (index.html at the root) and <out>.json:
// { version, checksum, minVersionCode, signature }. The signature (ECDSA P-256, SHA-256, base64 r||s) covers
// "version\nchecksum\nminVersionCode"; the app applies only bundles it can verify with its built-in public key.
// Without a key the bundle is unsigned (signature: null) and apps ignore it.
//
//   node scripts/app-bundle.mjs <dist dir> <out path without extension> [--key <private key PEM file>]
//   (the version is $GIT_SHA)
import { createHash, createPrivateKey, sign } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { zipSync } from "fflate";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const { values, positionals } = parseArgs({ allowPositionals: true, options: { key: { type: "string" } } });
const [distDir, out] = positionals;
if (!distDir || !out) throw new Error("Usage: app-bundle.mjs <dist dir> <out path> [--key <PEM file>]");

/** Every file under dir, keyed by its path relative to dir (forward slashes), in a stable order. */
function collect(dir, prefix = "", files = {}) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collect(full, `${prefix}${entry.name}/`, files);
    else files[`${prefix}${entry.name}`] = fs.readFileSync(full);
  }
  return files;
}

const files = collect(distDir);
if (!files["index.html"]) throw new Error(`${distDir} has no index.html`);
// Fixed timestamps: the same build gives the same zip.
const zip = zipSync(Object.fromEntries(Object.entries(files).map(([name, data]) => [name, [data, { mtime: new Date("2020-01-01T00:00:00Z") }]])), { level: 9 });

const version = process.env.GIT_SHA || "dev";
const checksum = createHash("sha256").update(zip).digest("hex");
const { minVersionCode } = JSON.parse(fs.readFileSync(path.join(ROOT, "client/native-baseline.json"), "utf8"));
const keyPem = values.key && fs.existsSync(values.key) ? fs.readFileSync(values.key, "utf8").trim() : "";

/** A key that is there but broken fails the build: shipping unsigned bundles by accident would stop all UI updates. */
function privateKey(pem) {
  try {
    return createPrivateKey(pem);
  } catch {
    const lines = pem.split("\n").length;
    throw new Error(
      `The bundle signing key isn't a valid PEM private key (${pem.length} characters, ${lines} line${lines === 1 ? "" : "s"}; ` +
        "a P-256 key has 5). Set the APP_BUNDLE_SIGNING_KEY secret from the file: gh secret set APP_BUNDLE_SIGNING_KEY < specharvest-bundle.pem",
    );
  }
}

const signature = keyPem
  ? sign("sha256", Buffer.from(`${version}\n${checksum}\n${minVersionCode}`), { key: privateKey(keyPem), dsaEncoding: "ieee-p1363" }).toString("base64")
  : null;

fs.writeFileSync(`${out}.zip`, zip);
fs.writeFileSync(`${out}.json`, `${JSON.stringify({ version, checksum, minVersionCode, signature })}\n`);
console.log(`App bundle ${version}: ${(zip.length / 1024).toFixed(0)} KB, ${signature ? "signed" : "UNSIGNED (apps will ignore it)"}`);
