import { pairingCode, type PairClaimResult } from "@specharvest/shared";
import { reconnect } from "./connection.ts";
import { newServerId, updateServers, type ServerEntry } from "./settings.ts";
import { updateState } from "./state.ts";

/**
 * "Connect via website": a device-code style pairing. This side keeps a random verifier and opens the web
 * app with only its sha256 (the challenge); the signed-in user approves there; this side then claims the
 * token with the verifier. The token never shows up in a URL, a page or the clipboard.
 *
 * Pairing a server that's already in the list (same origin) replaces its token; a new one is added.
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
  await updateState({ pairing: { serverUrl, code: pairingCode(challenge), message: "Approve this browser in the SpecHarvest tab that just opened" } });
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
    if (!res) await setPairingMessage(run, `Can't reach ${serverUrl} — retrying. If you approved, check the address and that the server is up.`);
    if (!res || res.status === 202) continue;
    if (!res.ok) {
      await updateState({ pairing: { serverUrl, code: null, message: `Pairing failed (HTTP ${res.status})` } });
      active = null;
      return;
    }
    const claim = (await res.json()) as PairClaimResult;
    const id = await addServer({ serverUrl, token: claim.token, email: claim.email, deviceName: claim.deviceName });
    await updateState({ pairing: null });
    active = null;
    await reconnect(id);
    return;
  }
  if (!run.cancelled) await updateState({ pairing: { serverUrl, code: null, message: "Pairing timed out — try again" } });
  if (active === run) active = null;
}

export function cancelPairing() {
  if (active) active.cancelled = true;
  active = null;
  void updateState({ pairing: null });
}

async function setPairingMessage(run: { cancelled: boolean }, message: string) {
  if (!run.cancelled) await updateState((s) => (s.pairing ? { pairing: { ...s.pairing, message } } : {}));
}

/** Adds a server, or updates the one with the same origin (pairing again). Returns its id. */
export async function addServer(entry: Omit<ServerEntry, "id" | "tabLimit">): Promise<string> {
  let id = "";
  await updateServers((list) => {
    const existing = list.find((x) => x.serverUrl === entry.serverUrl);
    id = existing?.id ?? newServerId();
    return existing ? list.map((x) => (x.id === id ? { ...x, ...entry } : x)) : [...list, { ...entry, id, tabLimit: null }];
  });
  return id;
}
