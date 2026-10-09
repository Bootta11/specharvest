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
  },
};

export default config;
