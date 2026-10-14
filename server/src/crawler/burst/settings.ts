import { isIP } from "node:net";
import { burstSettingsSchema, type BurstAccountStatus, type BurstSettingKey, type BurstSettings } from "@specharvest/shared";
import { z } from "zod";
import { env } from "../../config.ts";
import * as db from "../../db/sqlite.ts";
import { decryptSecret, encryptSecret } from "../../lib/secrets.ts";

const SETTINGS_KEY = "burst";
const ACCOUNT_KEY = "burst_account";
const IMAGE_KEY = "burst_image";
const TOKEN_AAD = "burst_do_token";

type Overrides = Partial<BurstSettings>;
interface StoredAccount {
  tokenEnc?: string;
  tokenLast4?: string;
  allowedIp?: string;
  region?: string;
  size?: string;
}

export interface BurstImageSetting {
  id: string;
  name: string;
  createdAt: string;
}

export const burstSettingsPatchSchema = burstSettingsSchema.partial().transform((value) => value as Partial<Record<BurstSettingKey, BurstSettings[BurstSettingKey] | null>>);
export const burstSettingsResetPatchSchema = z.object(
  Object.fromEntries(Object.entries(burstSettingsSchema.shape).map(([key, schema]) => [key, schema.nullable().optional()])) as {
    [K in BurstSettingKey]: z.ZodOptional<z.ZodNullable<(typeof burstSettingsSchema.shape)[K]>>;
  },
);

export const burstAccountPatchSchema = z
  .object({
    token: z.string().trim().min(1).max(500).nullable().optional(),
    allowedIp: z
      .string()
      .trim()
      .refine((value) => isIP(value) !== 0, "Allowed IP must be an IPv4 or IPv6 address")
      .nullable()
      .optional(),
    region: z.string().trim().min(1).max(100).nullable().optional(),
    size: z.string().trim().min(1).max(100).nullable().optional(),
  })
  .strict();

export function envBurstSettings(): BurstSettings {
  return {
    enabled: env.BURST_PROVIDER === "digitalocean" && !!env.BURST_DO_TOKEN && !!env.BURST_ALLOWED_IP,
    maxServers: env.BURST_MAX_SERVERS,
    tabs: env.BURST_TABS,
    minWaiting: env.BURST_MIN_WAITING,
    afterSeconds: env.BURST_AFTER_SECONDS,
    idleMinutes: env.BURST_IDLE_MINUTES,
    maxMinutes: env.BURST_MAX_MINUTES,
    maxHoursPerDay: env.BURST_MAX_HOURS_PER_DAY,
    autoRebuildDays: 7,
  };
}

export function burstOverrides(): Overrides {
  return burstSettingsSchema.partial().catch({}).parse(db.getSetting(SETTINGS_KEY) ?? {});
}

export function effectiveBurstSettings(): BurstSettings {
  return burstSettingsSchema.parse({ ...envBurstSettings(), ...burstOverrides() });
}

export function saveBurstSettings(patch: Partial<Record<BurstSettingKey, BurstSettings[BurstSettingKey] | null>>): BurstSettings {
  const next: Record<string, unknown> = { ...burstOverrides() };
  for (const [key, value] of Object.entries(burstSettingsResetPatchSchema.parse(patch))) {
    if (value === null) delete next[key];
    else if (value !== undefined) next[key] = value;
  }
  const parsed = burstSettingsSchema.partial().parse(next);
  if (Object.keys(parsed).length) db.setSetting(SETTINGS_KEY, parsed);
  else db.deleteSetting(SETTINGS_KEY);
  return effectiveBurstSettings();
}

const storedAccount = (): StoredAccount => db.getSetting<StoredAccount>(ACCOUNT_KEY) ?? {};

export function resolvedBurstAccount(): BurstAccountStatus & { token: BurstAccountStatus["token"] & { value: string | null } } {
  const stored = storedAccount();
  let token: string | null = null;
  let warning: string | undefined;
  if (stored.tokenEnc) {
    try {
      token = decryptSecret(stored.tokenEnc, TOKEN_AAD);
    } catch {
      warning = "The saved token cannot be decrypted. Enter it again.";
    }
  }
  const tokenSource = token ? "app" : env.BURST_DO_TOKEN ? "env" : null;
  token ??= env.BURST_DO_TOKEN ?? null;
  const allowedIp = stored.allowedIp ?? env.BURST_ALLOWED_IP ?? null;
  return {
    token: {
      value: token,
      set: !!token,
      last4: stored.tokenLast4 ?? (env.BURST_DO_TOKEN ? env.BURST_DO_TOKEN.slice(-4) : null),
      source: tokenSource,
      ...(warning ? { warning } : {}),
    },
    allowedIp,
    region: stored.region ?? env.BURST_REGION,
    size: stored.size ?? env.BURST_SIZE,
    sources: {
      allowedIp: stored.allowedIp ? "app" : env.BURST_ALLOWED_IP ? "env" : null,
      region: stored.region ? "app" : "env",
      size: stored.size ? "app" : "env",
    },
  };
}

export function publicBurstAccount(): BurstAccountStatus {
  const { token, ...account } = resolvedBurstAccount();
  const { value: _value, ...safeToken } = token;
  return { ...account, token: safeToken };
}

export function saveBurstAccount(patch: z.infer<typeof burstAccountPatchSchema>): BurstAccountStatus {
  const next = storedAccount();
  const value = burstAccountPatchSchema.parse(patch);
  if (value.token === null) {
    delete next.tokenEnc;
    delete next.tokenLast4;
  } else if (value.token !== undefined) {
    next.tokenEnc = encryptSecret(value.token, TOKEN_AAD);
    next.tokenLast4 = value.token.slice(-4);
  }
  for (const key of ["allowedIp", "region", "size"] as const) {
    if (value[key] === null) delete next[key];
    else if (value[key] !== undefined) next[key] = value[key];
  }
  if (Object.keys(next).length) db.setSetting(ACCOUNT_KEY, next);
  else db.deleteSetting(ACCOUNT_KEY);
  return publicBurstAccount();
}

export const burstAvailable = () => env.BURST_PROVIDER === "digitalocean" && !!resolvedBurstAccount().token.value && !!resolvedBurstAccount().allowedIp;

export const getBurstImage = () => db.getSetting<BurstImageSetting>(IMAGE_KEY);
export const saveBurstImage = (image: BurstImageSetting) => db.setSetting(IMAGE_KEY, image);
