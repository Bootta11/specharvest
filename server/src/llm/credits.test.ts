import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

process.env.OPENROUTER_API_KEY = "sk-test";
const { env } = await import("../config.ts");
const { clearCreditsCache, getProviderCredits } = await import("./credits.ts");

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("provider credits", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    clearCreditsCache();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    (env as { OPENROUTER_MANAGEMENT_KEY?: string }).OPENROUTER_MANAGEMENT_KEY = undefined;
  });
  afterEach(() => vi.unstubAllGlobals());

  it("maps key info and explains the missing account balance", async () => {
    fetchMock.mockResolvedValueOnce(json(200, { data: { label: "sk-or…", limit: 20, limit_remaining: 12.5, usage: 7.5, usage_daily: 0.4, usage_monthly: 3, is_free_tier: false } }));
    const c = await getProviderCredits(1_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(c.key).toEqual({ label: "sk-or…", limit: 20, remaining: 12.5, usage: 7.5, usageDaily: 0.4, usageMonthly: 3, freeTier: false });
    expect(c.account).toBeNull();
    expect(c.errors[0]).toMatch(/OPENROUTER_MANAGEMENT_KEY/);
  });

  it("reads the account balance with a management key and reports a 403", async () => {
    (env as { OPENROUTER_MANAGEMENT_KEY?: string }).OPENROUTER_MANAGEMENT_KEY = "mgmt";
    fetchMock.mockImplementation(async (url) =>
      String(url).endsWith("/credits")
        ? json(200, { data: { total_credits: 50, total_usage: 12.25 } })
        : json(403, { error: { message: "Forbidden" } }),
    );
    const c = await getProviderCredits(1_000);
    expect(c.account).toEqual({ totalCredits: 50, totalUsage: 12.25, remaining: 37.75 });
    expect(c.key).toBeNull();
    expect(c.errors).toEqual(["/key → 403: Forbidden"]);
  });

  it("caches for a minute", async () => {
    fetchMock.mockImplementation(async () => json(200, { data: { limit: null, usage: 1 } }));
    await getProviderCredits(1_000);
    await getProviderCredits(30_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await getProviderCredits(70_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("never throws on network errors", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNRESET"));
    const c = await getProviderCredits(1_000);
    expect(c.key).toBeNull();
    expect(c.errors).toContain("ECONNRESET");
  });
});
