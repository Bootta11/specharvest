# Browser extension

The SpecHarvest Chrome extension lets a crawl load its pages in **your own Chrome**
instead of the server's headless browser. Your Chrome has a real fingerprint,
your IP and the cookies you already have (Cloudflare clearance, site logins),
so it gets past most "are you a robot" checks that block the server. It costs
nothing to run. Everything else still happens on the server: LLM extraction,
change detection, storage, search and resume. LLM calls cost the same as before.

Desktop Chrome only (Chrome on Android has no extensions). The extension does not
solve CAPTCHAs or fake a fingerprint. It gets through only because it *is* a
normal browser, driven at a normal pace.

## Connect

Install the extension, then open its settings page (it opens by itself on install),
enter your SpecHarvest address and connect in one of two ways:

- **Approve on the website** (recommended). The extension opens
  `/connect-extension` in SpecHarvest. Sign in if asked, check that the code
  shown there matches the one in the extension, and click *Approve*. The token
  never shows up in a URL or on the page (see [How pairing works](#how-pairing-works)).
- **Paste a token**. Under *Account → Connected browsers → Create token* the
  web app shows a token (`shx_…`) once. Paste it into the extension and click
  *Verify and connect*. A regular API key (`shk_…`) works too, but a token can
  only do what the extension needs.

*Account → Connected browsers* lists every connected browser with its online
state. *Disconnect* revokes it at once: crawls running there stop, and you can
resume them.

## Use

- **Crawl form**: *Run in my browser* is on while your extension is connected.
  The page check then also runs in your browser. Untick it to use the server.
- **Bot wall**: when the server's browser hits a bot check (Cloudflare,
  DataDome…), the crawl stops instead of failing, and the job offers
  **Resume in my browser**.
- **Extension popup**, on any shop page:
  - **Crawl this listing** checks the page, then crawls it. An item page or a
    non-shop page gets a choice instead.
  - **Add this item** reads the page as your tab already shows it (no reload) and
    adds it to one of your collections from that site, or to a new one.
  - The popup also lists your running jobs with progress and *Stop*, and
    shows sites that are waiting for your permission.

### Site permissions

The extension has no access to any site until you allow it, one site at a time
(the site and its subdomains). The first crawl on a new site:

1. the job shows *Waiting for you to allow the SpecHarvest extension on olx.ba*;
2. Chrome shows a notification and the toolbar icon gets a **!** badge;
3. click the notification (or *Allow* in the popup) and confirm Chrome's prompt.

The crawl then goes on by itself. If nobody allows it within 5 minutes, the job
stops and you can resume it later. *Stop* ends the wait at once. Allowed sites
are listed in the extension's settings, where you can remove them.

### Where the tabs open

Set in the extension's settings:

| Setting | |
| --- | --- |
| Separate minimized window (default) | Out of your way. The window explains what it is |
| Separate window in the background | A normal, unfocused window. Every page renders, as if you were looking at it |
| Tab group in your current window | A collapsed "SpecHarvest" group you can watch |

**Sites that load more as you scroll.** Pages in a minimized window, or in a
background tab, are hidden. Chrome doesn't lay them out, so they don't scroll, and
"load more on scroll" never fires. So the first time a crawl reads a site's
listing, the extension checks it once:

1. it shows the listing briefly in a window behind yours and scrolls it;
2. if more items appear, that crawl and later crawls of the site run in that
   background window, and the walk scrolls for more;
3. if not, the tab goes back to the minimized window.

The answer is remembered for the site. Sites that use a background window carry a
*visible window* tag in the Sites list, and clicking it makes the extension check
again. You can turn this off in settings ("Use a background window for sites that
load more items as you scroll"). Crawls of such sites then stay minimized, read
only the first items, and say so. They never count the unread items as gone.
Sites with page numbers or a "Load more" button work fine while minimized. In
*Separate window in the background* mode every page renders anyway, so no check
runs.

*Tabs at once* (1–4, default 2) caps how many pages load in parallel. Fewer is
gentler on your computer and on the sites. The crawl window closes a minute after
the last crawl finishes. Closing it while a crawl runs only fails the pages that
were open.

### When the browser goes away

Closing Chrome, putting the computer to sleep or losing the network stops the
crawl as *Stopped: Your browser disconnected*. *Resume* (or *Resume on the
server*) continues the same job, skipping items it already read.

A server update is different. After the restart, the crawl waits up to 2 minutes for
the extension to reconnect, then continues on its own. If Chrome isn't back by then,
you get a "Crawl paused" notification
([Updates and restarts](deployment.md#updates-and-restarts)).

## How it works

```
server crawler ── PageDriver ──┬─ PuppeteerDriver   (server's headless Chrome)
                               └─ ExtensionDriver ── WSS /api/extension/ws ──► extension service worker
                                                                               ├─ chrome.tabs / windows (crawl tabs)
                                                                               ├─ chrome.scripting (bundled page scripts)
                                                                               └─ chrome.webRequest (status, network idle)
```

- The crawler only navigates, runs **page scripts**, clicks and waits
  (`server/src/crawler/driver.ts`). The page scripts are DOM functions in
  `shared/src/page-scripts.ts`. The server injects them with puppeteer and the
  extension **bundles** them, so both runners run the same code. The server only
  ever sends a script *name* and JSON arguments (URLs, selectors), never code.
  That is a Chrome Web Store requirement and closes off remote code execution.
- Protocol (`shared/src/extension.ts`): the extension sends `hello` with its
  token, then answers `command`s (`openTab`, `goto`, `run`, `click`,
  `waitIdle`, `closeTab`, `ensurePermission`, `showTab`, `probeScroll`) with `reply`. A ping every 20 s
  keeps the MV3 service worker alive and re-checks the token, so a revoked token
  or a disabled user is cut off within a minute. One connection per user: a
  newer one replaces the older.
- Scripts run in the extension's isolated world. The page can't see or change them.
- Network idle comes from `chrome.webRequest`, which only reports requests to
  sites the extension may access. That covers the site's own data requests,
  not third-party CDNs.

### How pairing works

Pairing works like OAuth's device flow with PKCE:

1. The extension keeps a random `verifier` and opens
   `/connect-extension?challenge=<sha256(verifier)>&device=<name>`.
2. You approve while signed in (`POST /api/extension/pair/approve`, session
   cookie only). The approval lives in memory for 5 minutes.
3. The extension polls `POST /api/extension/pair/claim {verifier}` and gets the
   token once.

Both sides show the first 8 characters of the challenge as a code, so a link
someone else sent you can't be approved by mistake.

### Security

- **What a token can do**: an extension token works only on
  `/api/extension/{whoami,status}`, `/api/config`, `GET /api/collections`,
  `POST /api/crawl[/inspect]` and `/api/jobs[/:id[/stop|resume]]`. Account,
  keys, LLM settings and admin endpoints refuse it (403).
- **Your network**: the server checks every URL against its private-address
  guard before sending it. The extension refuses localhost, private IPs and
  `.local`/`.internal`/`.lan` names too, also after redirects. A crawled link
  can't make your browser read your router or NAS.
- **Untrusted data**: whatever comes from a user's browser is treated as
  untrusted. Items read there (`items.from_browser`) are only reused by that
  user's own collections, never by other users' crawls, cross-user value reuse
  or web lookups. A listing structure detected there
  (`collections.detection_from_browser`) is never offered to other collections.
  A modified extension can only affect its own user's data.
- **CORS**: `chrome-extension://` origins may call the API with `X-Api-Key`
  only. Cookies never go cross-origin.

## Develop

```bash
npm run build:extension                 # → extension/dist/chrome-mv3 (load unpacked)
npm run dev --workspace extension       # WXT dev mode with reload
npm run zip:extension                   # Web Store upload zip
```

Load it in `chrome://extensions` → *Developer mode* → *Load unpacked* and pick
`extension/dist/chrome-mv3`. For a local server, use `http://localhost:3100` as
the address. Only localhost may be plain http.

- **After a rebuild, reload the extension** in `chrome://extensions`. Chrome
  can keep running the previous service worker otherwise. End-to-end runs with a
  reused profile hit this.
- **Automated tests**: automation can't click Chrome's permission prompt.
  `SPECHARVEST_TEST_HOSTS="https://olx.ba/*,https://*.olx.ba/*" npm run build:extension`
  builds into `extension/dist-test/` with those sites allowed at install. Never upload
  that build. Branded Chrome ignores `--load-extension`, so use Chrome for
  Testing (`~/.cache/puppeteer/chrome/…`) with `--load-extension=<dir>`.
- Server tests: `server/src/extension/extension.test.ts` covers pairing, token
  scope, the gateway, permission waits, disconnects and data isolation.
  `server/src/crawler/page-scripts.test.ts` covers the page scripts (jsdom,
  rebuilt from their source text the way both runners run them).

## Publish to the Chrome Web Store

1. Bump `version` in `extension/package.json`, then run `npm run zip:extension`.
2. Store listing: single purpose is "lets your SpecHarvest server load shop pages
   in your browser". Use the icons from `extension/public/icon`.
3. Permission justifications:
   - `tabs`, `tabGroups`, `scripting`, `webNavigation`, `webRequest` (observe
     only): open, read and watch the crawl tabs.
   - `storage`: settings and token.
   - `alarms`: reconnect.
   - `notifications`: ask for site access.
   - `activeTab`: *Add this item* on the open tab.
   - Optional host access: per site, on request.
4. Privacy policy: [extension-privacy.md](extension-privacy.md), published at a
   public URL.
5. Set `EXTENSION_STORE_URL` on the server so the crawl form links to the store.
