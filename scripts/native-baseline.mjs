#!/usr/bin/env node
// The native baseline: which APK a web UI bundle needs (see docs/app-updates.md#the-native-baseline).
// A UI bundle may only run on an APK built from the same native code. This hashes the native inputs (the
// Android project, the Capacitor config and the installed native plugin versions) and keeps the hash in
// client/native-baseline.json next to minVersionCode, the first APK versionCode with that native code.
//
//   node scripts/native-baseline.mjs           print the current hash
//   node scripts/native-baseline.mjs --check   fail when the native code changed without a --bump (CI)
//   node scripts/native-baseline.mjs --bump <versionCode>
//                                              record the current hash for the APK release <versionCode>
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE = path.join(ROOT, "client/native-baseline.json");

/** Files in the repo (tracked or new, not git-ignored): cap sync's generated, ignored files never count. */
function repoFiles(dir) {
  const out = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", dir], { cwd: ROOT, encoding: "utf8" });
  return out
    .split("\0")
    .filter(Boolean)
    .filter((f) => fs.existsSync(path.join(ROOT, f)))
    // Not part of the APK: examples, gitignores and the unused test stubs.
    .filter((f) => !/(\.example|\.gitignore)$/.test(f) && !/\/src\/(test|androidTest)\//.test(f))
    .sort();
}

/** Installed versions of the client's dependencies that carry Android code (Capacitor plugins). */
function nativePlugins() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "client/package.json"), "utf8"));
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, "package-lock.json"), "utf8"));
  return Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })
    .filter((name) => fs.existsSync(path.join(ROOT, "node_modules", name, "android")) || name === "@capacitor/android")
    .sort()
    .map((name) => `${name}@${lock.packages[`node_modules/${name}`]?.version ?? lock.packages[`client/node_modules/${name}`]?.version}`);
}

function currentHash() {
  const h = createHash("sha256");
  for (const f of [...repoFiles("client/android"), "client/capacitor.config.ts"]) {
    h.update(`${f}\0`);
    h.update(fs.readFileSync(path.join(ROOT, f)));
    h.update("\0");
  }
  for (const p of nativePlugins()) h.update(`${p}\0`);
  return h.digest("hex");
}

const { values } = parseArgs({ options: { check: { type: "boolean" }, bump: { type: "string" } } });
const hash = currentHash();

if (values.bump !== undefined) {
  const minVersionCode = Number(values.bump);
  if (!Number.isInteger(minVersionCode) || minVersionCode < 1) throw new Error(`--bump needs a versionCode, got "${values.bump}"`);
  fs.writeFileSync(BASELINE, `${JSON.stringify({ minVersionCode, hash }, null, 2)}\n`);
  console.log(`Native baseline: minVersionCode ${minVersionCode}, hash ${hash}`);
} else if (values.check) {
  const baseline = JSON.parse(fs.readFileSync(BASELINE, "utf8"));
  if (baseline.hash !== hash) {
    console.error(
      "The native code changed (client/android, capacitor.config.ts or a native plugin version), so UI bundles from\n" +
        "this commit need a new APK. Run: node scripts/native-baseline.mjs --bump <versionCode of the next release>\n" +
        "and release that version as an APK (see docs/app-updates.md#the-native-baseline).",
    );
    process.exit(1);
  }
  console.log(`Native baseline ok (minVersionCode ${baseline.minVersionCode}).`);
} else {
  console.log(hash);
}
