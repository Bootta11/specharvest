// First: configures zod before any schema runs.
import "./lib/zod-config.ts";
import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./index.css";
import { isNative, loadNativeSettings } from "./lib/platform.ts";

// Android app: pick up links shared from other apps (lib/share.ts), even before signing in.
if (isNative) void import("./lib/native.ts").then(({ listenForShares }) => listenForShares());

// Android app: the "update available" banner, on every screen (docs/app-updates.md).
const UpdateBanner = lazy(() => import("./components/UpdateBanner.tsx").then((m) => ({ default: m.UpdateBanner })));

// The app reads its server and sign-in token from native storage first (lib/platform.ts).
void loadNativeSettings().then(() => {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
      {isNative && (
        <Suspense>
          <UpdateBanner />
        </Suspense>
      )}
    </StrictMode>,
  );
  // Live UI updates (also tells the updater this UI started fine) and new APKs, before and after sign-in.
  if (isNative) {
    void import("./lib/updates.ts").then(({ initUpdates }) => initUpdates());
    void import("./lib/apk-update.ts").then(({ initApkUpdates }) => initApkUpdates());
  }
});
