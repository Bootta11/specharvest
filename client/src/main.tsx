// First: configures zod before any schema runs.
import "./lib/zod-config.ts";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./index.css";
import { isNative, loadNativeSettings } from "./lib/platform.ts";

// Android app: pick up links shared from other apps (lib/share.ts), even before signing in.
if (isNative) void import("./lib/native.ts").then(({ listenForShares }) => listenForShares());

// The app reads its server and sign-in token from native storage first (lib/platform.ts).
void loadNativeSettings().then(() =>
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  ),
);
