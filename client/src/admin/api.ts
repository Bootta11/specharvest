import type {
  AdminSettings,
  BrowserInput,
  BrowserPatch,
  BrowserStatus,
  BrowserTestResult,
  BurstBuildStatus,
  BurstOptions,
  BurstSettings,
  BurstStatus,
  CapacityRun,
  ProviderCredits,
  UsageSummary,
  UserCreated,
  UserRole,
  UserSummary,
} from "@specharvest/shared";
import { request } from "../lib/api.ts";

/** The admin dashboard's API: everything under /api/admin (server/src/admin/routes.ts). */
export const adminApi = {
  users: () => request<UserSummary[]>("GET", "/api/admin/users"),
  createUser: (email: string, role: UserRole) => request<UserCreated>("POST", "/api/admin/users", { email, role }),
  setUserDisabled: (id: number, disabled: boolean) => request<UserSummary>("PATCH", `/api/admin/users/${id}`, { disabled }),
  settings: () => request<AdminSettings>("GET", "/api/admin/settings"),
  saveSettings: (body: Partial<Pick<AdminSettings, "signupEnabled" | "serverLlmAccess" | "serverLlmDailyLimitUsd">>) =>
    request<AdminSettings>("PUT", "/api/admin/settings", body),
  usage: () => request<UsageSummary>("GET", "/api/admin/usage"),
  credits: () => request<ProviderCredits>("GET", "/api/admin/credits"),
  burstStatus: () => request<BurstStatus>("GET", "/api/admin/burst"),
  saveBurstSettings: (body: Partial<Record<keyof BurstSettings, BurstSettings[keyof BurstSettings] | null>>) => request<BurstStatus>("PUT", "/api/admin/burst", body),
  saveBurstAccount: (body: { token?: string | null; allowedIp?: string | null; region?: string | null; size?: string | null }) =>
    request<BurstStatus>("PUT", "/api/admin/burst/account", body),
  testBurst: (token?: string) => request<Record<string, { ok: boolean; error?: string }>>("POST", "/api/admin/burst/test", token ? { token } : {}),
  burstOptions: () => request<BurstOptions>("GET", "/api/admin/burst/options"),
  detectBurstIp: () => request<{ ip: string }>("POST", "/api/admin/burst/detect-ip"),
  rebuildBurstImage: () => request<BurstBuildStatus>("POST", "/api/admin/burst/image"),
  browsers: () => request<BrowserStatus[]>("GET", "/api/admin/browsers"),
  createBrowser: (body: BrowserInput) => request<BrowserStatus[]>("POST", "/api/admin/browsers", body),
  updateBrowser: (id: number, body: BrowserPatch) => request<BrowserStatus[]>("PUT", `/api/admin/browsers/${id}`, body),
  deleteBrowser: (id: number) => request<BrowserStatus[]>("DELETE", `/api/admin/browsers/${id}`),
  testBrowser: (body: { id?: number; url?: string; apiKey?: string; username?: string; password?: string }) =>
    request<BrowserTestResult>("POST", "/api/admin/browsers/test", body),
  capacityTest: () => request<{ run: CapacityRun | null }>("GET", "/api/admin/browsers/capacity"),
  startCapacityTest: (name: string) => request<{ run: CapacityRun }>("POST", "/api/admin/browsers/capacity", { name }),
  stopCapacityTest: () => request<{ run: CapacityRun | null }>("DELETE", "/api/admin/browsers/capacity"),
};
