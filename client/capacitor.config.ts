import type { CapacitorConfig } from "@capacitor/cli";

/** Android app (see docs/mobile-app.md). The UI ships inside the APK and talks to the chosen server's API. */
const config: CapacitorConfig = {
  appId: "dev.bootta.specharvest",
  appName: "SpecHarvest",
  webDir: "dist",
  server: {
    // The app runs at https://localhost — the origin the server's CORS allows (APP_ORIGINS).
    androidScheme: "https",
  },
  plugins: {
    LocalNotifications: { smallIcon: "ic_stat_specharvest", iconColor: "#0f766e" },
    // Live UI updates from the server, driven by lib/updates.ts (docs/app-updates.md). Nothing goes to Capgo's
    // cloud: no auto-update checks, no stats.
    CapacitorUpdater: { autoUpdate: false, appReadyTimeout: 10000, statsUrl: "", resetWhenUpdate: true },
  },
};

export default config;
