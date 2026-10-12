import { pairingCode, type PairClaimResult } from "@specharvest/shared";
import { reconnect } from "./connection.ts";
import { saveSettings } from "./settings.ts";
import { updateState } from "./state.ts";

/**
 * "Connect via website": a device-code style pairing. This side keeps a random verifier and opens the web
 * app with only its sha256 (the challenge); the signed-in user approves there; this side then claims the
 * token with the verifier. The token never shows up in a URL, a page or the clipboard.
 */

const POLL_MS = 2_000;
const GIVE_UP_MS = 5 * 60_000;

let active: { cancelled: boolean } | null = null;

const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export async function startPairing(serverUrl: string, deviceName: string) {
  cancelPairing();
  const run = { cancelled: false };
  active = run;
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  await updateState({ pairingCode: pairingCode(challenge), status: "connecting", message: "Approve this browser in the SpecHarvest tab that just opened" });
  await chrome.tabs.create({ url: `${serverUrl}/connect-extension?challenge=${challenge}&device=${encodeURIComponent(deviceName)}` });

  const end = Date.now() + GIVE_UP_MS;
  while (!run.cancelled && Date.now() < end) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    if (run.cancelled) break;
    const res = await fetch(`${serverUrl}/api/extension/pair/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ verifier }),
    }).catch(() => null);
    // A network or CORS failure looks the same from here; say so instead of waiting silently.
    if (!res) await updateState({ message: `Can't reach ${serverUrl} — retrying. If you approved, check the address and that the server is up.` });
    if (!res || res.status === 202) continue;
    if (!res.ok) {
      await updateState({ pairingCode: null, status: "error", message: `Pairing failed (HTTP ${res.status})` });
      active = null;
      return;
    }
    const claim = (await res.json()) as PairClaimResult;
    await saveSettings({ serverUrl, token: claim.token, email: claim.email, deviceName: claim.deviceName });
    await updateState({ pairingCode: null, message: "" });
    active = null;
    await reconnect();
    return;
  }
  if (!run.cancelled) await updateState({ pairingCode: null, status: "unconfigured", message: "Pairing timed out — try again" });
  if (active === run) active = null;
}

export function cancelPairing() {
  if (active) active.cancelled = true;
  active = null;
}
