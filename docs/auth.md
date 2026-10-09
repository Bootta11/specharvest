# Users & access

SpecHarvest needs a sign-in. The design follows `../cardkiln`, ported to this
stack: Fastify + `node:sqlite`, with Node's built-in scrypt instead of argon2,
so no native module is needed.

## First admin

Pick one:

```bash
npm run seed:admin -- --email you@example.com                # prints a generated password once
npm run seed:admin -- --email you@example.com --password '…'

# Docker
docker compose exec app /nodejs/bin/node --import tsx server/src/scripts/seed-admin.ts --email you@example.com
```

Or set `ADMIN_EMAIL` (and optionally `ADMIN_PASSWORD`) in `.env`. When the
database has no users, the server creates that admin on boot. If
`ADMIN_PASSWORD` is blank, it logs a generated password once. Both ways do
nothing once any user exists.

**Data from before users existed** goes to the first admin when that admin is
created (and again on any later boot if ownerless rows remain). That covers
collections, their jobs, LLM spend, push subscriptions, recent searches and
the notification channels.

## Roles

| | User | Admin |
| --- | --- | --- |
| Own collections: crawl, rename, share, delete | ✓ | ✓ (everyone's) |
| Search collections shared by others (read only) | ✓ | ✓ |
| See others' private collections, jobs, spend | — | ✓ (spend via *Everyone* in the `$` menu) |
| Add users, disable/enable users, toggle sign-up | — | ✓ (*Users & sign-up* in the avatar menu) |
| Choose who may use the server's LLM key; add a custom (self-hosted) LLM endpoint | — | ✓ (see [LLM providers](llm-providers.md)) |

**Sharing:** the owner clicks *Share* on a collection. Every user can then pick
it in Search and open its items. They cannot crawl, rename or delete it. A web
lookup that someone else runs on a shared collection is billed to them, and its
results fill in the shared items for everyone.

**Re-crawling** a URL reuses *your* collection for it. Crawling the URL of a
collection someone shared with you creates your own copy.

**Per user:** jobs (and the live jobs feed), *Recent* searches, notification
channels (🔔), Web Push browsers, LLM API keys and model picks
(*LLM provider*, encrypted at rest), LLM spend. A job runs on the keys of the
person who started it.

**Shared by everyone:** the web-lookup fact cache (`web_facts`) and the
parsed-query cache. Neither holds anything personal; caching across users only
saves LLM calls.

## Accounts

- **Admin-created users** get a temporary password, shown once, which the admin
  passes on (there is no email sending). Users change it under *Account*.
- **Self sign-up** is off by default. With it on, the sign-in page offers
  *Create one*, and new accounts are regular users.
- **Changing your email or password** needs the current password. A new
  password signs out your other devices.
- **Disabling** a user ends their sessions and blocks sign-in and API keys
  until they are re-enabled. Their collections stay. Admins can't disable
  themselves.
- **Limits for regular users:** at most `MAX_ACTIVE_JOBS_PER_USER` (3)
  crawls and web lookups running at once, crawls of at most `MAX_PAGES_CAP` /
  `MAX_ITEMS_CAP` (50 pages / 1000 items), and a daily allowance on the
  server's LLM key (see [LLM providers](llm-providers.md#for-admins)). Admins
  have none of these limits.
- **Importing** creates private collections of the importer. The file's
  product grouping and web lookup cache rows are shared by everyone, so they
  are only added when an admin imports. Imported listings are never reused for
  other users' crawls or lookups until a crawl here has read them again.

## Sessions & API keys

- **Login** sets the httpOnly cookie `specharvest_session` (`SameSite=Lax`).
  The session lasts 30 days from last use, and each use pushes the expiry back.
  `Secure` is on when `PUBLIC_URL` is `https://…`; set `SESSION_COOKIE_SECURE`
  to override, e.g. `false` when testing over plain HTTP on a LAN IP.
  `localhost` is fine either way.
- **Android app** sessions are the same sessions, but the token is returned to the app and sent as
  `Authorization: Bearer …` instead of living in a cookie (see [Android app](mobile-app.md)).
  Sign-out and a password change end them like any other session.
- **API keys** (`shk_…`, *Account → API keys*) act as their owner. Send them in
  an `X-Api-Key` header. A key is shown only at creation and can be revoked at
  any time.
- **Storage:** only sha256 hashes of session tokens and API keys are kept.
  Passwords are hashed with salted scrypt (`scrypt$N$r$p$salt$hash`).
- **Rate limit:** login, sign-up and account changes (which check the current
  password) allow 10 attempts per minute per IP. The client IP comes from
  `X-Forwarded-For` only when a trusted proxy set it (`TRUST_PROXY`, see
  [deployment](deployment.md#security-settings)), so a client can't fake it.
  Routes that spend LLM money or start work are limited per user, e.g. 30
  searches and 10 crawls a minute.
- **Cross-site requests:** writes made with the session cookie (and sign-in
  itself) must come from the app's own pages. The browser's `Sec-Fetch-Site`
  (or `Origin`) header is checked, so another site can't post on your behalf.
  Requests with an `X-Api-Key` or the app's bearer token aren't affected.
