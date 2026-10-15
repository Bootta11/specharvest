// First: configures zod before any schema runs.
import "../lib/zod-config.ts";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import AdminApp from "./AdminApp.tsx";
import "../index.css";

// The admin dashboard (/admin/): web only, its own entry so the app (and the Android APK's UI) never loads admin code.
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AdminApp />
  </StrictMode>,
);
