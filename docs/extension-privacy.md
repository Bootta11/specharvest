# SpecHarvest extension: privacy policy

The SpecHarvest extension connects your Chrome to **your own SpecHarvest server**,
the address you enter in its settings. It has no other backend and sends nothing
anywhere else.

## What it does with data

- **Pages it opens for crawls you start**: it loads the shop pages your crawls
  ask for, only on sites you allowed. It sends their text, links and basic page
  data (title, price, images, structured data) to your SpecHarvest server, where
  they become items in your collections.
- **The page you're on**: only when you click *Crawl this listing* or *Add this
  item* in the popup. Then it sends that page's address (and, for *Add this
  item*, its text) to your server.
- **Settings**: your server address, connection token, account email, browser
  name and preferences. They stay in Chrome's extension storage on this computer.

## What it doesn't do

- It doesn't read your other tabs, history, bookmarks, passwords or form input.
- It doesn't track you, show ads, or sell or share data with anyone.
- It doesn't run code from the server. All of its code ships inside the
  extension.
- It doesn't open local-network addresses (localhost, private IPs).

## Your control

- Site access is granted one site at a time. Remove it any time in the
  extension's settings or in Chrome.
- *Disconnect* in the extension, or under *Account → Connected browsers* in
  SpecHarvest, revokes the extension's token.
- What your server stores is up to whoever runs it. See its own terms.
