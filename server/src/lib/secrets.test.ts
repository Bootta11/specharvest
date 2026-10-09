import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

// config.ts reads DATA_DIR at import time — point it at a throwaway dir first.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "specharvest-secrets-"));
process.env.DATA_DIR = dataDir;
delete process.env.ENCRYPTION_KEY;
const { env } = await import("../config.ts");
const { decryptSecret, encryptSecret, resetMasterKey } = await import("./secrets.ts");

afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }));

describe("secrets at rest", () => {
  beforeEach(() => {
    env.ENCRYPTION_KEY = undefined;
    resetMasterKey();
  });

  it("round-trips, with a fresh IV every time", () => {
    const a = encryptSecret("sk-test-123456", "llm-key:1:openai");
    const b = encryptSecret("sk-test-123456", "llm-key:1:openai");
    expect(a).not.toBe(b);
    expect(a.startsWith("v1.")).toBe(true);
    expect(a).not.toContain("sk-test");
    expect(decryptSecret(a, "llm-key:1:openai")).toBe("sk-test-123456");
  });

  it("generates the master key once into DATA_DIR, readable only by the owner", () => {
    const blob = encryptSecret("x", "aad");
    const file = path.join(dataDir, "encryption.key");
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    // A restart reads the same key back.
    resetMasterKey();
    expect(decryptSecret(blob, "aad")).toBe("x");
  });

  it("refuses another owner's ciphertext, tampering and a changed master key", () => {
    const blob = encryptSecret("sk-secret", "llm-key:1:openai");
    expect(() => decryptSecret(blob, "llm-key:2:openai")).toThrow();
    const [v, iv, tag, ct] = blob.split(".");
    const flipped = Buffer.from(ct, "base64url");
    flipped[0] ^= 1;
    expect(() => decryptSecret([v, iv, tag, flipped.toString("base64url")].join("."), "llm-key:1:openai")).toThrow();
    expect(() => decryptSecret("v0.a.b.c", "llm-key:1:openai")).toThrow("Unknown secret format");

    env.ENCRYPTION_KEY = "11".repeat(32); // hex
    resetMasterKey();
    expect(() => decryptSecret(blob, "llm-key:1:openai")).toThrow();
    expect(decryptSecret(encryptSecret("y", "a"), "a")).toBe("y");
  });

  it("rejects a master key of the wrong size", () => {
    env.ENCRYPTION_KEY = Buffer.alloc(16).toString("base64");
    resetMasterKey();
    expect(() => encryptSecret("x", "a")).toThrow("32 bytes");
  });
});
