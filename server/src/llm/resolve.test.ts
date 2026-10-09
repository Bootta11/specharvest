import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

// config.ts reads env at import time — throwaway DATA_DIR, a (fake) server key, default models.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "specharvest-resolve-"));
process.env.DATA_DIR = dataDir;
process.env.OPENROUTER_API_KEY = "sk-or-server-test";
for (const k of ["OPENROUTER_MODEL", "OPENROUTER_EXTRACTION_MODEL", "OPENROUTER_SMART_MODEL", "OPENROUTER_WEB_MODEL", "ENCRYPTION_KEY"]) delete process.env[k];
const db = await import("../db/sqlite.ts");
const users = await import("../auth/users.ts");
const keys = await import("./keys.ts");
const { llmStatus, resolveModel, requireLlm, setServerLlmAccess, setServerDailyLimitUsd, serverDailyLimitUsd, DEFAULT_SERVER_DAILY_LIMIT_USD, LlmUnavailableError } = await import("./resolve.ts");

afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }));

const admin = await users.createUser("admin@example.com", "password1", "admin");
const user = await users.createUser("user@example.com", "password1", "user");

describe("LLM resolver", () => {
  beforeEach(() => {
    setServerLlmAccess("everyone");
    setServerDailyLimitUsd(DEFAULT_SERVER_DAILY_LIMIT_USD);
    db.getDb().exec("DELETE FROM llm_usage");
    for (const u of [admin, user]) {
      for (const k of keys.listKeys(u.id)) keys.deleteKey(u.id, k.provider);
      keys.saveModelChoices(u.id, { fast: null, smart: null, web: null });
    }
    keys.clearKeyCache();
  });

  it("runs on the server key with the OPENROUTER_* models when the user has no key", () => {
    const s = llmStatus(user.id);
    expect(s.effective.fast).toEqual({ funding: "platform", provider: "openrouter", model: "google/gemini-2.5-flash-lite" });
    expect(s.effective.smart).toEqual({ funding: "platform", provider: "openrouter", model: "google/gemini-2.5-flash" });
    expect(s.effective.web).toMatchObject({ funding: "platform", provider: "openrouter" });
    expect(s.unavailable).toEqual({});
    const r = resolveModel(user.id, "extract");
    expect(r).toMatchObject({ funding: "platform", modelId: "google/gemini-2.5-flash-lite", keyOwner: null });
  });

  it("follows the admin's server-key policy", () => {
    setServerLlmAccess("admins");
    expect(llmStatus(admin.id).effective.fast?.funding).toBe("platform");
    expect(llmStatus(user.id).effective.fast).toBeNull();
    expect(llmStatus(user.id).unavailable.fast).toMatch(/Add an LLM API key in Settings → LLM provider/);
    expect(() => requireLlm(user.id, "fast")).toThrow(LlmUnavailableError);
    expect(() => resolveModel(user.id, "search")).toThrow(/Add an LLM API key/);

    setServerLlmAccess("nobody");
    expect(llmStatus(admin.id).effective.fast).toBeNull();
    // Background work with no user still runs on the server key.
    expect(resolveModel(null, "detect").funding).toBe("platform");
  });

  it("uses the user's own key first, by catalog order, with the provider's defaults", () => {
    setServerLlmAccess("admins");
    keys.saveKey(user.id, "deepseek", "sk-deepseek-123456", null);
    let s = llmStatus(user.id);
    expect(s.effective.fast).toEqual({ funding: "own", provider: "deepseek", model: "deepseek-flash" });
    expect(s.effective.smart).toEqual({ funding: "own", provider: "deepseek", model: "deepseek-v4-pro" });
    // DeepSeek can't search the web and the server key isn't allowed for this user.
    expect(s.effective.web).toBeNull();
    expect(s.unavailable.web).toMatch(/can search the web/);

    keys.saveKey(user.id, "openai", "sk-openai-123456", null);
    s = llmStatus(user.id);
    expect(s.effective.fast).toEqual({ funding: "own", provider: "openai", model: "gpt-5-nano" });
    expect(s.effective.web).toEqual({ funding: "own", provider: "openai", model: "gpt-5-mini" });

    const r = resolveModel(user.id, "web-lookup", { webSearch: true });
    expect(r).toMatchObject({ funding: "own", modelId: "gpt-5-mini", keyOwner: user.id, jsonMode: true });
    // Always a model object built with the key — never a "provider/model" string (that would go via Vercel's gateway).
    expect(typeof r.model).toBe("object");
    expect(r.model.provider).toMatch(/^openai/);
    expect(Object.keys(r.tools ?? {})).toEqual(["web_search"]);
  });

  it("honours model picks, and ignores ones it can't serve", () => {
    keys.saveKey(user.id, "deepseek", "sk-deepseek-123456", null);
    keys.saveKey(user.id, "groq", "gsk-groq-123456", null);
    keys.saveModelChoices(user.id, {
      fast: { provider: "deepseek", model: "deepseek-v4-pro" },
      smart: null,
      // Groq's browser search only runs on gpt-oss — this pick can't search, so web falls back to automatic.
      web: { provider: "groq", model: "llama-3.3-70b-versatile" },
    });
    const s = llmStatus(user.id);
    expect(s.effective.fast).toEqual({ funding: "own", provider: "deepseek", model: "deepseek-v4-pro" });
    expect(s.effective.smart).toEqual({ funding: "own", provider: "deepseek", model: "deepseek-v4-pro" });
    expect(s.effective.web).toEqual({ funding: "own", provider: "groq", model: "openai/gpt-oss-120b" });
  });

  it("removing a key clears the picks that used it", () => {
    keys.saveKey(user.id, "deepseek", "sk-deepseek-123456", null);
    keys.saveModelChoices(user.id, { fast: { provider: "deepseek", model: "x" }, smart: null, web: null });
    expect(keys.deleteKey(user.id, "deepseek")).toBe(true);
    expect(keys.modelChoices(user.id).fast).toBeNull();
    expect(llmStatus(user.id).effective.fast?.funding).toBe("platform");
  });

  it("skips (and flags) a key that can't be decrypted", () => {
    keys.saveKey(user.id, "openai", "sk-openai-123456", null);
    expect(keys.listKeys(user.id)[0]).toMatchObject({ provider: "openai", keyHint: "3456", lastError: null });
    // Stored ciphertext is not the key.
    const row = db.getDb().prepare("SELECT key_enc FROM llm_keys WHERE user_id = ?").get(user.id) as { key_enc: string };
    expect(row.key_enc).not.toContain("sk-openai");
    db.getDb().prepare("UPDATE llm_keys SET key_enc = 'v1.AAAA.BBBB.CCCC' WHERE user_id = ?").run(user.id);
    keys.clearKeyCache();
    expect(llmStatus(user.id).effective.fast?.funding).toBe("platform");
    expect(keys.listKeys(user.id)[0].lastError).toMatch(/can't be decrypted/);
  });

  it("keeps each user's keys to themselves", () => {
    keys.saveKey(admin.id, "anthropic", "sk-ant-123456789", null);
    expect(llmStatus(admin.id).effective.fast).toMatchObject({ funding: "own", provider: "anthropic" });
    expect(llmStatus(user.id).effective.fast?.funding).toBe("platform");
    expect(keys.listKeys(user.id)).toEqual([]);
  });

  it("stops a user's work on the server key once today's limit is spent; admins and own keys aren't limited", () => {
    const spend = (userId: number, cost: number, at = Date.now()) =>
      db.getDb()
        .prepare("INSERT INTO llm_usage (created_at, purpose, provider, model, funding, cost, user_id) VALUES (?, 'extract', 'openrouter', 'm', 'platform', ?, ?)")
        .run(at, cost, userId);
    expect(serverDailyLimitUsd()).toBe(1);
    setServerDailyLimitUsd(0.05);

    spend(user.id, 0.04);
    spend(user.id, 0.5, db.startOfDay() - 1000); // yesterday's spend doesn't count
    expect(llmStatus(user.id).effective.fast?.funding).toBe("platform");

    spend(user.id, 0.02);
    expect(llmStatus(user.id).effective.fast).toBeNull();
    expect(llmStatus(user.id).unavailable.fast).toMatch(/today's \$0\.05 on the server's LLM key/);
    expect(() => requireLlm(user.id, "fast")).toThrow(LlmUnavailableError);
    expect(() => resolveModel(user.id, "extract")).toThrow(LlmUnavailableError);

    spend(admin.id, 5);
    expect(llmStatus(admin.id).effective.fast?.funding).toBe("platform");

    keys.saveKey(user.id, "deepseek", "sk-deepseek-123456", null);
    expect(llmStatus(user.id).effective.fast).toMatchObject({ funding: "own", provider: "deepseek" });

    setServerDailyLimitUsd(0);
    keys.deleteKey(user.id, "deepseek");
    expect(llmStatus(user.id).effective.fast?.funding).toBe("platform");
  });
});
