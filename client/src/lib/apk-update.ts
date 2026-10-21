import { App as CapacitorApp } from "@capacitor/app";
import { Capacitor, CapacitorHttp, registerPlugin, type PluginListenerHandle } from "@capacitor/core";
import { ZEALOT_CHANNEL_KEY, ZEALOT_URL } from "./app-release.ts";

/**
 * Android app, direct build only: new APKs from Zealot (docs/app-updates.md). Asks Zealot for a newer build on start
 * and on resume (at most every 6 hours); the banner (components/UpdateBanner.tsx) offers it, and AppInstaller
 * (native, src/direct) downloads it and hands it to Android's package installer. The Play build has no AppInstaller:
 * Play updates the app there.
 */

interface AppInstallerPlugin {
  canInstall(): Promise<{ value: boolean }>;
  openInstallSettings(): Promise<void>;
  install(options: { url: string }): Promise<void>;
  addListener(event: "progress", listener: (e: { percent: number }) => void): Promise<PluginListenerHandle>;
}

const AppInstaller = registerPlugin<AppInstallerPlugin>("AppInstaller");

export const canSelfUpdate = () => Capacitor.isPluginAvailable("AppInstaller") && !!ZEALOT_CHANNEL_KEY;

export interface ApkRelease {
  versionName: string;
  versionCode: number;
  changelog: string;
  url: string;
}

const CHECK_EVERY_MS = 6 * 60 * 60_000;
let lastCheck = 0;
let available: ApkRelease | null = null;
const listeners = new Set<() => void>();

export const availableRelease = () => available;

export function onReleaseChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

interface ZealotRelease {
  release_version?: string;
  build_version?: string;
  changelog?: string | Array<{ message?: string }>;
  install_url?: string;
}

const changelogText = (c: ZealotRelease["changelog"]) =>
  typeof c === "string" ? c.trim() : (c ?? []).map((e) => e.message?.trim()).filter(Boolean).join("\n");

async function check() {
  if (Date.now() - lastCheck < CHECK_EVERY_MS) return;
  lastCheck = Date.now();
  try {
    const info = await CapacitorApp.getInfo();
    // Native HTTP: no CORS setup needed on Zealot.
    const res = await CapacitorHttp.get({
      url: `${ZEALOT_URL}/api/apps/latest`,
      params: { channel_key: ZEALOT_CHANNEL_KEY, bundle_id: info.id, release_version: info.version, build_version: info.build },
    });
    if (res.status !== 200) return;
    // Zealot answers one release or a list of the newer ones.
    const raw = (res.data as { releases?: ZealotRelease | ZealotRelease[] } | null)?.releases;
    const newest = [raw ?? []]
      .flat()
      .map((r) => ({ versionName: r.release_version ?? "", versionCode: Number(r.build_version), changelog: changelogText(r.changelog), url: r.install_url ?? "" }))
      .filter((r) => r.versionCode > Number(info.build) && /^https?:/.test(r.url))
      .sort((a, b) => b.versionCode - a.versionCode)[0];
    available = newest ?? null;
    listeners.forEach((l) => l());
  } catch (err) {
    console.error("App update check failed:", err);
  }
}

/** Checks now and whenever the app comes back to the foreground. */
export async function initApkUpdates() {
  if (!canSelfUpdate()) return;
  void check();
  await CapacitorApp.addListener("appStateChange", ({ isActive }) => {
    if (isActive) void check();
  });
}

/** Whether Android lets this app install APKs ("Install unknown apps" for SpecHarvest). */
export const canInstall = async () => (await AppInstaller.canInstall()).value;

export const openInstallSettings = () => AppInstaller.openInstallSettings();

/** Downloads and installs the release; resolves once Android took over (it may show its confirm screen). */
export async function installRelease(release: ApkRelease, onProgress: (percent: number) => void) {
  const handle = await AppInstaller.addListener("progress", (e) => onProgress(e.percent));
  try {
    await AppInstaller.install({ url: release.url });
  } finally {
    void handle.remove();
  }
}
