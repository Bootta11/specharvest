import { defineConfig } from "wxt";
import tailwindcss from "@tailwindcss/vite";

// Test builds only (end-to-end runs): sites allowed at install, since automation can't click Chrome's permission
// prompt. Built into dist-test so a store zip never carries them.
const testHosts = (process.env.SPECHARVEST_TEST_HOSTS ?? "").split(",").filter(Boolean);

// Chrome Web Store build: MV3, no remote code, site access only per site on demand (docs/extension.md).
export default defineConfig({
  srcDir: "src",
  outDir: testHosts.length ? "dist-test" : "dist", // not dot-folders: macOS file pickers hide those (Load unpacked)
  modules: ["@wxt-dev/module-react"],
  vite: () => ({ plugins: [tailwindcss()] }),
  // Dev-reload server; off 3000, where a Puppeteer ssh tunnel usually sits.
  dev: { server: { port: 4719 } },
  manifest: {
    name: "SpecHarvest",
    description: "Lets SpecHarvest crawl shop listings in your own Chrome — the sites you allow, at your pace.",
    minimum_chrome_version: "120",
    permissions: ["storage", "tabs", "tabGroups", "scripting", "webRequest", "webNavigation", "alarms", "notifications", "activeTab"],
    optional_host_permissions: ["http://*/*", "https://*/*"],
    action: { default_title: "SpecHarvest" },
    ...(testHosts.length ? { host_permissions: testHosts } : {}),
  },
});
