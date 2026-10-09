import { App as CapacitorApp } from "@capacitor/app";
import { Browser } from "@capacitor/browser";
import { Directory, Encoding, Filesystem } from "@capacitor/filesystem";
import { LocalNotifications } from "@capacitor/local-notifications";
import { Share } from "@capacitor/share";
import { RESUME_EVENT } from "./api.ts";

/**
 * Android-only glue (Capacitor), imported lazily from the app shell. Notifications work like
 * cursor-agent-remote's: the app follows the jobs feed while it's alive (foreground or background) and posts
 * a local notification when a job finishes; when it comes back to the foreground the feed reconnects and
 * catches up on anything that finished meanwhile.
 */

let foreground = true;

export const isAppForeground = () => foreground;

/** Sets up notifications, foreground tracking, the back button and external links. Returns a cleanup. */
export async function initNative(onOpenJob: (jobId: number) => void): Promise<() => void> {
  const removers: Array<() => void> = [];

  const state = await CapacitorApp.addListener("appStateChange", ({ isActive }) => {
    foreground = isActive;
    // Android drops idle connections in the background — reconnect the streams right away.
    if (isActive) window.dispatchEvent(new Event(RESUME_EVENT));
  });
  removers.push(() => void state.remove());

  // Hardware back: close the open dialog or menu (they all close on Escape), otherwise leave the app.
  const back = await CapacitorApp.addListener("backButton", () => {
    if (document.querySelector('[aria-modal="true"], [role="menu"], [role="dialog"]')) {
      // Bubbles to window too, so listeners on either see it exactly once.
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    } else void CapacitorApp.minimizeApp();
  });
  removers.push(() => void back.remove());

  // Links to shops and sources open in the system browser, not inside the app.
  const onClick = (e: MouseEvent) => {
    const a = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
    if (!a || !/^https?:/i.test(a.href) || new URL(a.href).origin === location.origin) return;
    e.preventDefault();
    void Browser.open({ url: a.href });
  };
  document.addEventListener("click", onClick, true);
  removers.push(() => document.removeEventListener("click", onClick, true));

  try {
    if ((await LocalNotifications.requestPermissions()).display === "granted") {
      const tap = await LocalNotifications.addListener("localNotificationActionPerformed", (action) => {
        const jobId = Number(action.notification.extra?.jobId);
        if (jobId) onOpenJob(jobId);
      });
      removers.push(() => void tap.remove());
    }
  } catch (err) {
    console.error("Local notification setup failed:", err);
  }

  return () => removers.forEach((r) => r());
}

/** A notification for a finished job; tapping it opens the job. */
export async function notifyJob(jobId: number, title: string, body: string) {
  try {
    await LocalNotifications.schedule({ notifications: [{ id: jobId, title, body, extra: { jobId } }] });
  } catch (err) {
    console.error("Failed to post a notification:", err);
  }
}

/** Saves a text file to the app cache and opens the share sheet (Save to Files, Drive, mail…). */
export async function shareTextFile(name: string, text: string) {
  const { uri } = await Filesystem.writeFile({ path: name, data: text, directory: Directory.Cache, encoding: Encoding.UTF8 });
  await Share.share({ title: name, files: [uri] });
}
