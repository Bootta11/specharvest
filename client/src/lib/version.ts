import { App as CapacitorApp } from "@capacitor/app";
import { isNative } from "./platform.ts";

/**
 * What's running, for the account menu. The UI version is the commit its build came from (`dev` for local builds),
 * so after a live update (lib/updates.ts) it shows the server's commit. The app version is the installed APK.
 */
export const uiVersion = __APP_SHA__ === "dev" ? "dev" : __APP_SHA__.slice(0, 7);

export interface NativeVersion {
  name: string;
  code: string;
}

let native: Promise<NativeVersion | null> | null = null;

/** The installed APK's versionName and versionCode; null on the web. */
export function nativeVersion(): Promise<NativeVersion | null> {
  native ??= isNative
    ? CapacitorApp.getInfo()
        .then((info) => ({ name: info.version, code: info.build }))
        .catch(() => null)
    : Promise.resolve(null);
  return native;
}
