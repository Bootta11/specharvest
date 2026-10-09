# Android app

The same React UI, packaged with [Capacitor](https://capacitorjs.com) 8 as an Android app
(`client/android`). The UI ships inside the APK and talks to a SpecHarvest server's API:
`https://specharvest.bootta.dev` by default, or any server you enter on the sign-in screen
(*Use a custom server…*).

## Build and install

Needs JDK 21 and the Android SDK (Android Studio installs both).

1. **Build the web UI and copy it into the Android project:**
   ```bash
   npm run cap:sync --workspace client
   ```
2. **Build the debug APK** (JDK 21 may not be the default; point `JAVA_HOME` at it):
   ```bash
   cd client/android
   JAVA_HOME=/opt/homebrew/opt/openjdk@21 ./gradlew assembleDebug
   ```
   The APK is `client/android/app/build/outputs/apk/debug/app-debug.apk`.
3. **Install it over wireless debugging.** On the phone: Developer options → Wireless debugging →
   *Pair device with pairing code*, then on the computer:
   ```bash
   adb pair <ip:pairing-port> <code>
   adb connect <ip:port>
   adb devices -l
   adb -s <device> install -r client/android/app/build/outputs/apk/debug/app-debug.apk
   ```

`npm run android --workspace client` opens the project in Android Studio instead.

The app id is `dev.bootta.specharvest`. App and notification icons and the splash screen are
generated from `client/public/favicon.svg`.

## How the app signs in

The web UI uses the httpOnly session cookie on its own origin. The app runs at
`https://localhost` (Capacitor's origin), so it can't use that cookie:

- It signs in with the header `X-SpecHarvest-Client: app`. Login and sign-up then return
  `{ user, token }` and set no cookie.
- The token is a normal session (30 days from last use, stored as a sha256 hash, revoked by
  sign-out or a password change). It's kept on the phone and sent as `Authorization: Bearer <token>`.
- The server allows cross-origin calls only from the app's origins: `https://localhost` and
  `http://localhost`, plus anything in `APP_ORIGINS` (comma-separated). It allows them only with
  bearer tokens, never cookies.
- Live job progress is a server-sent event stream. In the app it's read with `fetch` so the token
  can be sent, and it reconnects on its own.

A custom server needs this version of SpecHarvest or later. Older servers refuse the app's sign-in.

## Notifications

They work like cursor-agent-remote's: the app follows your jobs while it's open or in the
background, and posts a phone notification when a crawl or web lookup finishes or fails. Tapping it
opens the job. There's no notification for the job you're already looking at. When the app comes
back to the foreground, it reconnects and catches up on jobs that finished in the meantime.

Android may stop a background app after a while, and a closed app gets nothing. For alerts then,
use a server-side channel from 🔔: ntfy, Telegram, Discord/Slack, webhook or Apprise. Browser Web
Push doesn't work inside the app, so its toggle is hidden there.

## Phone specifics

- The back button closes the open dialog or menu, otherwise it sends the app to the background.
- Links to shops and sources open in the system browser.
- *Export* saves the `.json` file and opens the share sheet (Files, Drive, mail…).
