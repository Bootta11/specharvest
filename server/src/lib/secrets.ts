import fs from "node:fs";
import path from "node:path";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { env } from "../config.ts";
import { createLogger } from "./logger.ts";

const log = createLogger("secrets");

/**
 * Secrets the server must be able to read back (users' LLM API keys) are encrypted at rest with
 * AES-256-GCM. A copy of the database alone (backup, stolen file) doesn't reveal them.
 *
 * Master key: ENCRYPTION_KEY (32 bytes, base64 or hex). When it's blank, one is generated once into
 * DATA_DIR/encryption.key — that keeps the app zero-config, but anyone with the data volume has both,
 * so production should set ENCRYPTION_KEY and back it up. Losing it means users re-enter their keys.
 */
const VERSION = "v1";
const KEY_FILE = "encryption.key";

let masterKey: Buffer | null = null;

function parseKey(raw: string): Buffer {
  const s = raw.trim();
  const buf = /^[0-9a-f]{64}$/i.test(s) ? Buffer.from(s, "hex") : Buffer.from(s, "base64");
  if (buf.length !== 32) throw new Error("ENCRYPTION_KEY must be 32 bytes, base64 or hex (openssl rand -base64 32)");
  return buf;
}

function loadMasterKey(): Buffer {
  if (masterKey) return masterKey;
  if (env.ENCRYPTION_KEY) return (masterKey = parseKey(env.ENCRYPTION_KEY));
  const file = path.join(env.DATA_DIR, KEY_FILE);
  if (fs.existsSync(file)) return (masterKey = parseKey(fs.readFileSync(file, "utf8")));
  const key = randomBytes(32);
  fs.mkdirSync(env.DATA_DIR, { recursive: true });
  try {
    fs.writeFileSync(file, key.toString("base64") + "\n", { mode: 0o600, flag: "wx" });
  } catch (err) {
    // Another process created it first — use theirs.
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return (masterKey = parseKey(fs.readFileSync(file, "utf8")));
    throw err;
  }
  log.warn(`ENCRYPTION_KEY is not set — generated ${file}. Set ENCRYPTION_KEY in production and back it up: without it, stored LLM keys can't be read.`);
  return (masterKey = key);
}

const b64 = (b: Buffer) => b.toString("base64url");

/** `v1.<iv>.<tag>.<ciphertext>`. `aad` binds the ciphertext to its owner (e.g. user + provider). */
export function encryptSecret(plain: string, aad: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", loadMasterKey(), iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [VERSION, b64(iv), b64(cipher.getAuthTag()), b64(ct)].join(".");
}

/** Whether a stored value is an encryptSecret blob (rather than plain text saved before encryption existed). */
export function isEncryptedSecret(value: string): boolean {
  return /^v1\.[\w-]+\.[\w-]+\.[\w-]*$/.test(value);
}

/** Throws when the blob was tampered with, belongs to another `aad`, or the master key changed. */
export function decryptSecret(blob: string, aad: string): string {
  const [version, iv, tag, ct] = blob.split(".");
  if (version !== VERSION || !iv || !tag || ct === undefined) throw new Error("Unknown secret format");
  const decipher = createDecipheriv("aes-256-gcm", loadMasterKey(), Buffer.from(iv, "base64url"));
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ct, "base64url")), decipher.final()]).toString("utf8");
}

/** Test hook: forget the cached master key (e.g. after changing ENCRYPTION_KEY). */
export function resetMasterKey() {
  masterKey = null;
}
