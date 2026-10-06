# Notifications

Crawls run on the server, so closing the tab doesn't stop them. The header shows
how many jobs are running, and the **Collections** tab lists them live
(*Running now*). Open the 🔔 button in the header to choose how you're alerted
when a job ends.

**Events:** crawl finished, crawl failed (both on by default), web lookup finished.

Every channel has a **Send test** button. Tests use the saved settings, so any
pending edits are saved first. A failing channel is logged
(`[notify]` in the server log) and never affects the crawl or the other channels.

## This browser

| Option | Works when | Needs |
| --- | --- | --- |
| Desktop notifications | SpecHarvest is open in some tab (background is fine) | Notification permission |
| Web Push | the tab is closed (the browser must be running) | HTTPS or `localhost`, notification permission |

Both use the tag `job-<id>`, so if both are on you get a single notification.
Clicking it opens `/?job=<id>`, which shows that job's progress view.
Each browser opts in on its own. Turning Web Push off removes that browser's
subscription.

The VAPID keys are generated on first use and stored in the `settings` table.
To pin them yourself (e.g. when moving the DB), set `VAPID_PUBLIC_KEY` /
`VAPID_PRIVATE_KEY` (`npx web-push generate-vapid-keys`). Changing the keys
breaks existing subscriptions, so re-enable push in each browser afterwards.

## Server-side channels

| Channel | Setup |
| --- | --- |
| **ntfy** | Install the ntfy app and subscribe to a hard-to-guess topic. Use `https://ntfy.sh` or your own server; the token is optional (for protected topics). Failures are sent with high priority. |
| **Telegram** | Create a bot with @BotFather to get the token. Send the bot a message, then open `https://api.telegram.org/bot<token>/getUpdates` and copy `chat.id`. |
| **Discord / Slack** | Discord: channel → *Edit* → *Integrations* → *Webhooks*. Slack incoming-webhook URLs (`hooks.slack.com`) are detected automatically. |
| **Webhook** | JSON `POST {event, title, body, url, collection, job}`; `event` is `crawlDone`, `crawlFailed`, `enrichDone` or `test`. |
| **Apprise** | 130+ services (email, Pushover, Matrix, Gotify, …) through an [Apprise API](https://github.com/caronc/apprise-api) container. Start it with `docker compose --profile apprise up -d`, set the API URL to `http://apprise:8000` and add [Apprise URLs](https://github.com/caronc/apprise/wiki), one per line. |

Secrets (tokens, webhook URLs, Apprise URLs) are never sent back to the UI.
The API returns `********` in their place, and saving the form unchanged keeps
the stored value.

Set `PUBLIC_URL` (e.g. `https://specharvest.example`) to include a link to the
job in ntfy, Telegram, Discord and Apprise messages.

## Limits

- A server restart marks running crawls as *interrupted* (resumable — see
  [Stop & resume](crawling.md#stop--resume)) and running web lookups as failed.
  No notification is sent for these, nor when you stop a crawl yourself.
- Notifications are sent once and not retried.
