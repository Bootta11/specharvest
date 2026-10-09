import { useEffect, useState, type ReactNode } from "react";
import type { NotificationChannel, NotificationSettings } from "@specharvest/shared";
import {
  api,
  browserNotifyEnabled,
  browserNotifySupported,
  currentPushSubscription,
  disablePush,
  enablePush,
  pushSupported,
  registerServiceWorker,
  setBrowserNotify,
  showLocalNotification,
} from "../lib/api.ts";
import { isNative } from "../lib/platform.ts";

type ChannelKey = Exclude<NotificationChannel, "push">;
type TestState = { busy?: boolean; ok?: boolean; error?: string };

function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; hint?: ReactNode }) {
  return (
    <label className="flex cursor-pointer items-start gap-3 py-1.5">
      <input type="checkbox" className="mt-0.5 size-4 shrink-0 accent-brand-700" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="min-w-0">
        <span className="block text-sm font-medium">{label}</span>
        {hint && <span className="block text-xs text-stone-500">{hint}</span>}
      </span>
    </label>
  );
}

function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-stone-600 dark:text-stone-400">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-stone-500">{hint}</span>}
    </label>
  );
}

function TestResult({ state }: { state: TestState | undefined }) {
  if (!state || state.busy) return null;
  return state.ok ? (
    <span className="text-xs text-emerald-700 dark:text-emerald-300">Sent ✓</span>
  ) : (
    <span className="min-w-0 break-words text-xs text-red-700 dark:text-red-300">{state.error}</span>
  );
}

const CHANNELS: Array<{ key: ChannelKey; title: string; blurb: string }> = [
  { key: "ntfy", title: "ntfy", blurb: "Push to your phone/desktop via the ntfy app (ntfy.sh or self-hosted)." },
  { key: "telegram", title: "Telegram", blurb: "Message from your own bot." },
  { key: "discord", title: "Discord / Slack", blurb: "Incoming webhook of a channel." },
  { key: "webhook", title: "Webhook", blurb: "JSON POST to any URL (n8n, Home Assistant, …)." },
  { key: "apprise", title: "Apprise", blurb: "130+ services (email, Pushover, Matrix, …) through an Apprise API container." },
];

export function SettingsModal({ onClose }: { onClose: () => void }) {
  const [settings, setSettings] = useState<NotificationSettings | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [tests, setTests] = useState<Partial<Record<NotificationChannel, TestState>>>({});
  const [open, setOpen] = useState<ChannelKey | null>(null);
  const [localOn, setLocalOn] = useState(browserNotifyEnabled);
  const [pushOn, setPushOn] = useState(false);
  const [browserMsg, setBrowserMsg] = useState<string | null>(null);

  useEffect(() => {
    api.notificationSettings().then(setSettings, (err) => setError((err as Error).message));
    currentPushSubscription().then((s) => setPushOn(!!s), () => {});
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [onClose]);

  const update = <K extends keyof NotificationSettings>(section: K, patch: Partial<NotificationSettings[K]>) => {
    setSettings((s) => (s ? { ...s, [section]: { ...s[section], ...patch } } : s));
    setDirty(true);
    setSaved(false);
  };

  const save = async () => {
    if (!settings) return;
    setSaving(true);
    setError(null);
    try {
      setSettings(await api.saveNotificationSettings(settings));
      setDirty(false);
      setSaved(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  // Tests use stored settings, so save pending edits first.
  const test = async (channel: NotificationChannel) => {
    setTests((t) => ({ ...t, [channel]: { busy: true } }));
    try {
      if (dirty) await save();
      const r = await api.testNotification(channel);
      setTests((t) => ({ ...t, [channel]: r }));
    } catch (err) {
      setTests((t) => ({ ...t, [channel]: { ok: false, error: (err as Error).message } }));
    }
  };

  const toggleLocal = async (on: boolean) => {
    setBrowserMsg(null);
    if (on) {
      const perm = await Notification.requestPermission();
      if (perm !== "granted") {
        setBrowserMsg("Notification permission was denied — allow it in the browser's site settings.");
        return;
      }
      await registerServiceWorker();
    }
    setBrowserNotify(on);
    setLocalOn(on);
  };

  const togglePush = async (on: boolean) => {
    setBrowserMsg(null);
    try {
      if (on) await enablePush();
      else await disablePush();
      setPushOn(on);
    } catch (err) {
      setBrowserMsg((err as Error).message);
    }
  };

  const testLocal = () => showLocalNotification("SpecHarvest test notification", "Desktop notifications are working.", `test-${Date.now()}`, "/");

  const ev = settings?.events;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 sm:items-center sm:p-4" onClick={onClose} role="dialog" aria-modal="true" aria-label="Settings">
      <div className="flex max-h-[92dvh] w-full max-w-2xl flex-col overflow-hidden rounded-t-2xl bg-white shadow-xl sm:rounded-2xl dark:bg-stone-900" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3 border-b border-stone-200 p-4 dark:border-stone-800">
          <h2 className="mr-auto font-semibold">My notifications</h2>
          <button onClick={onClose} className="btn-ghost btn-sm" aria-label="Close">
            ✕
          </button>
        </div>

        <div className="space-y-6 overflow-y-auto p-4">
          {!settings ? (
            <p className="text-sm text-stone-500">{error ?? "Loading…"}</p>
          ) : (
            <>
              <section>
                <h3 className="mb-1 text-sm font-semibold">Notify me when</h3>
                <Toggle checked={ev!.crawlDone} onChange={(v) => update("events", { crawlDone: v })} label="A crawl finishes" />
                <Toggle checked={ev!.crawlFailed} onChange={(v) => update("events", { crawlFailed: v })} label="A crawl fails" />
                <Toggle checked={ev!.enrichDone} onChange={(v) => update("events", { enrichDone: v })} label="A web lookup finishes" />
              </section>

              <section>
                <h3 className="mb-1 text-sm font-semibold">{isNative ? "This phone" : "This browser"}</h3>
                {isNative ? (
                  <p className="text-sm text-stone-500">
                    The app notifies you when a crawl or web lookup finishes, while it's open or in the background. Jobs that finish while it's closed show up next time
                    you open it — for alerts then, use one of the channels below (e.g. ntfy or Telegram).
                  </p>
                ) : !browserNotifySupported() ? (
                  <p className="text-sm text-stone-500">This browser doesn't support notifications.</p>
                ) : (
                  <>
                    <div className="flex flex-wrap items-center gap-x-3">
                      <div className="mr-auto">
                        <Toggle checked={localOn} onChange={toggleLocal} label="Desktop notifications" hint="While SpecHarvest is open in a tab (even in the background)." />
                      </div>
                      {localOn && (
                        <button className="btn-ghost btn-sm" onClick={testLocal}>
                          Send test
                        </button>
                      )}
                    </div>
                    <div className="flex flex-wrap items-center gap-x-3">
                      <div className="mr-auto">
                        <Toggle
                          checked={pushOn}
                          onChange={togglePush}
                          label="Also when the tab is closed (Web Push)"
                          hint={pushSupported() ? "Delivered by the browser's push service — needs the browser running." : "Needs HTTPS (or localhost)."}
                        />
                      </div>
                      {pushOn && (
                        <div className="flex items-center gap-2">
                          <TestResult state={tests.push} />
                          <button className="btn-ghost btn-sm" disabled={tests.push?.busy} onClick={() => test("push")}>
                            Send test
                          </button>
                        </div>
                      )}
                    </div>
                    {browserMsg && <p className="mt-1 text-xs text-red-700 dark:text-red-300">{browserMsg}</p>}
                  </>
                )}
              </section>

              <section>
                <h3 className="mb-2 text-sm font-semibold">Other channels</h3>
                <div className="divide-y divide-stone-200 rounded-lg border border-stone-200 dark:divide-stone-800 dark:border-stone-800">
                  {CHANNELS.map((c) => {
                    const expanded = open === c.key;
                    const enabled = settings[c.key].enabled;
                    return (
                      <div key={c.key}>
                        <button className="flex w-full items-center gap-3 px-3 py-2.5 text-left" onClick={() => setOpen(expanded ? null : c.key)} aria-expanded={expanded}>
                          <span className={`size-2 shrink-0 rounded-full ${enabled ? "bg-emerald-500" : "bg-stone-300 dark:bg-stone-600"}`} aria-hidden />
                          <span className="min-w-0 flex-1">
                            <span className="block text-sm font-medium">{c.title}</span>
                            <span className="block truncate text-xs text-stone-500">{c.blurb}</span>
                          </span>
                          <span className="text-xs text-stone-500">{enabled ? "On" : "Off"}</span>
                          <span className={`text-stone-400 transition ${expanded ? "rotate-90" : ""}`} aria-hidden>
                            ›
                          </span>
                        </button>
                        {expanded && (
                          <div className="space-y-3 px-3 pb-3">
                            <Toggle checked={enabled} onChange={(v) => update(c.key, { enabled: v })} label={`Send to ${c.title}`} />
                            <ChannelFields channel={c.key} settings={settings} update={update} />
                            <div className="flex flex-wrap items-center justify-end gap-2">
                              <TestResult state={tests[c.key]} />
                              <button className="btn-ghost btn-sm" disabled={tests[c.key]?.busy} onClick={() => test(c.key)}>
                                {tests[c.key]?.busy ? "Sending…" : "Send test"}
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </section>
            </>
          )}
        </div>

        <div className="flex items-center gap-3 border-t border-stone-200 p-4 dark:border-stone-800">
          <span className="mr-auto min-w-0 text-xs">
            {error ? <span className="text-red-700 dark:text-red-300">{error}</span> : saved ? <span className="text-emerald-700 dark:text-emerald-300">Saved</span> : dirty ? <span className="text-stone-500">Unsaved changes</span> : null}
          </span>
          <button className="btn-ghost" onClick={onClose}>
            Close
          </button>
          <button className="btn-primary" disabled={!dirty || saving} onClick={save}>
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

function ChannelFields({
  channel,
  settings,
  update,
}: {
  channel: ChannelKey;
  settings: NotificationSettings;
  update: <K extends keyof NotificationSettings>(section: K, patch: Partial<NotificationSettings[K]>) => void;
}) {
  switch (channel) {
    case "ntfy":
      return (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Server">
            <input className="input" value={settings.ntfy.server} onChange={(e) => update("ntfy", { server: e.target.value })} placeholder="https://ntfy.sh" />
          </Field>
          <Field label="Topic" hint="Pick something hard to guess — public topics are readable by anyone.">
            <input className="input" value={settings.ntfy.topic} onChange={(e) => update("ntfy", { topic: e.target.value })} placeholder="specharvest-x7k2…" />
          </Field>
          <Field label="Access token (optional)">
            <input className="input" type="password" autoComplete="off" value={settings.ntfy.token} onChange={(e) => update("ntfy", { token: e.target.value })} />
          </Field>
        </div>
      );
    case "telegram":
      return (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Bot token" hint="Create a bot with @BotFather.">
            <input className="input" type="password" autoComplete="off" value={settings.telegram.botToken} onChange={(e) => update("telegram", { botToken: e.target.value })} />
          </Field>
          <Field label="Chat id" hint="Message the bot, then open api.telegram.org/bot<token>/getUpdates.">
            <input className="input" value={settings.telegram.chatId} onChange={(e) => update("telegram", { chatId: e.target.value })} placeholder="123456789" />
          </Field>
        </div>
      );
    case "discord":
      return (
        <Field label="Webhook URL" hint="Discord: channel settings → Integrations → Webhooks. Slack incoming webhooks work too.">
          <input className="input" type="password" autoComplete="off" value={settings.discord.webhookUrl} onChange={(e) => update("discord", { webhookUrl: e.target.value })} placeholder="https://discord.com/api/webhooks/…" />
        </Field>
      );
    case "webhook":
      return (
        <Field label="URL" hint="Receives {event, title, body, url, collection, job} as JSON.">
          <input className="input" type="password" autoComplete="off" value={settings.webhook.url} onChange={(e) => update("webhook", { url: e.target.value })} placeholder="https://…" />
        </Field>
      );
    case "apprise":
      return (
        <div className="grid gap-3">
          <Field label="Apprise API URL" hint="With Docker: docker compose --profile apprise up -d → http://apprise:8000">
            <input className="input" value={settings.apprise.apiUrl} onChange={(e) => update("apprise", { apiUrl: e.target.value })} placeholder="http://apprise:8000" />
          </Field>
          <Field label="Apprise URLs" hint="One per line, e.g. mailto://user:pass@gmail.com or pover://user@token. See the Apprise wiki.">
            <textarea
              className="input h-24 py-2 font-mono text-xs"
              value={settings.apprise.urls}
              onChange={(e) => update("apprise", { urls: e.target.value })}
            />
          </Field>
        </div>
      );
  }
}
