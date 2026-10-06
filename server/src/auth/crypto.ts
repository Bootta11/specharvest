import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from "node:crypto";

const scrypt = (password: string, salt: Buffer, keylen: number, opts: ScryptOptions) =>
  new Promise<Buffer>((resolve, reject) => scryptCb(password, salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key))));

// scrypt (built into Node — no native module) with a per-password salt. Parameters are stored with
// each hash so they can be raised later without breaking existing passwords.
const N = 2 ** 16;
const R = 8;
const P = 1;
const KEYLEN = 32;
const maxmem = (n: number, r: number) => 256 * n * r;

/** Passwords are low-entropy and human-chosen, so they need a slow, salted KDF — unlike the random tokens below. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, KEYLEN, { N, r: R, p: P, maxmem: maxmem(N, R) });
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, n, r, p, salt, hash] = stored.split("$");
  if (alg !== "scrypt" || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64url");
  const key = await scrypt(password, Buffer.from(salt, "base64url"), expected.length, { N: Number(n), r: Number(r), p: Number(p), maxmem: maxmem(Number(n), Number(r)) });
  return timingSafeEqual(key, expected);
}

/** A precomputed hash to verify against when the email is unknown, so response time doesn't reveal which emails exist. */
let dummyHash: Promise<string> | null = null;
export function dummyPasswordHash(): Promise<string> {
  return (dummyHash ??= hashPassword(randomBytes(16).toString("hex")));
}

/** High-entropy random token (sessions, API keys) — a fast hash is enough to store it. */
export function randomToken(prefix: string): string {
  return `${prefix}${randomBytes(32).toString("hex")}`;
}

export function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/** Readable temporary password for admin-created users. */
export function temporaryPassword(): string {
  return randomBytes(12).toString("base64url");
}
