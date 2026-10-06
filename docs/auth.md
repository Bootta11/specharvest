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

**Sharing:** the owner clicks *Share* on a collection. Every user can then pick
it in Search and open its items. They cannot crawl, rename or delete it. A web
lookup that someone else runs on a shared collection is billed to them, and its
results fill in the shared items for everyone.

**Re-crawling** a URL reuses *your* collection for it. Crawling the URL of a
collection someone shared with you creates your own copy.

**Per user:** jobs (and the live jobs feed), *Recent* searches, notification
channels (🔔), Web Push browsers, LLM spend.

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

## Sessions & API keys

- **Login** sets the httpOnly cookie `specharvest_session` (`SameSite=Lax`).
  The session lasts 30 days from last use, and each use pushes the expiry back.
  `Secure` is on when `PUBLIC_URL` is `https://…`; set `SESSION_COOKIE_SECURE`
  to override, e.g. `false` when testing over plain HTTP on a LAN IP.
  `localhost` is fine either way.
- **API keys** (`shk_…`, *Account → API keys*) act as their owner. Send them in
  an `X-Api-Key` header. A key is shown only at creation and can be revoked at
  any time.
- **Storage:** only sha256 hashes of session tokens and API keys are kept.
  Passwords are hashed with salted scrypt (`scrypt$N$r$p$salt$hash`).
- **Rate limit:** login and sign-up allow 10 attempts per minute per IP. The
  server trusts `X-Forwarded-For` because it runs behind a tunnel or reverse
  proxy.
