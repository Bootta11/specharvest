# App releases and updates

Until the app is on Google Play, testers install it from Zealot (`https://apps.bootta.dev`), and the app
keeps itself up to date in two ways:

1. **The UI, silently.** Most changes only touch the React UI inside the app. The server hands out the UI
   built from its own commit, the app downloads it in the background and switches to it the next time it's
   reopened. If the new UI fails to start, the app goes back to the previous one by itself.
2. **The app itself, with a prompt.** Changes to the native part (Android code, Capacitor plugins) need a new
   APK. The app asks Zealot for newer builds and shows an *Update available* banner. **Update** downloads the
   APK and installs it.

There are two builds of the app (Gradle product flavors in `client/android/app/build.gradle`):

| | `direct` — the APK on Zealot | `play` — the Google Play bundle |
|---|---|---|
| Built by | `npm run android:apk --workspace client` (`assembleDirectRelease`) | `npm run android:bundle --workspace client` (`bundlePlayRelease`) |
| Output | `apk/direct/release/app-direct-release.apk` | `bundle/playRelease/app-play-release.aab` |
| Silent UI updates | yes | yes (Play allows code that runs in the WebView) |
| Installs new APKs | yes (`src/direct`: AppInstaller, install permissions) | no: Play updates the app; Play rejects self-installing apps |
| Signed with | the app signing key | the upload key ([Google Play](google-play.md#3-create-the-upload-key)) |

Both have the same app id and are built from the same tag with the same version, so a phone that installed
the Zealot APK takes the Play version later without reinstalling (Play signs with the same app signing key,
see [Google Play, step 8](google-play.md#8-play-app-signing)).

## Releasing

Push a tag `vX.Y.Z`. CI's `android` job (`.github/workflows/ci.yml`):

1. takes the version from the tag: `versionName X.Y.Z`, `versionCode X*10000 + Y*100 + Z` (so `v0.1.2` → 102);
2. builds the UI into the Android project (`cap:sync`) and the signed direct APK, plus the Play bundle when
   the upload key secrets are set;
3. checks the APK's signature and uploads it to Zealot, with the tag's message as the changelog;
4. keeps the `.aab` as a workflow artifact, for Google Play.

```bash
git tag -a v0.1.2 -m "Faster search; fixed the share sheet"
git push origin v0.1.2
```

The same tag also publishes the server image (see [deployment](deployment.md)), and with it the UI bundle.
Local builds without `-PversionCode` are version `1` / `1.0`.

## Live UI updates

- The Docker build also builds the app's UI (`vite build --mode app`) and packs it with
  `scripts/app-bundle.mjs` into `client/dist-app.zip` + `client/dist-app.json`.
- `GET /api/app/bundle` returns `{ version, url, checksum, minVersionCode, signature }`
  (`version` is the image's git commit), and `GET /api/app/bundle.zip` the zip. Both are public; without a
  bundle (dev) they answer `404`.
- The app (`client/src/lib/updates.ts`) asks its current server on start, on return to the foreground (at
  most every 30 minutes) and after switching servers. A different version is downloaded with
  [`@capgo/capacitor-updater`](https://github.com/Cap-go/capacitor-updater) and applied the next time the app
  goes to the background and comes back. When the server runs the commit the APK was built from, the app goes
  back to the UI inside the APK. So the UI always matches its server's API, custom servers included.
- Each UI start calls `notifyAppReady()`. A UI that doesn't within 10 s is rolled back.
- Local builds (no `GIT_SHA`, so version `dev`) never update, so a debug build keeps your local UI.
- The plugin talks only to your server: no Capgo cloud, no stats (`statsUrl: ""` in `capacitor.config.ts`).

### Bundle signing

A UI bundle runs with everything the app can reach, including the sign-in tokens of all saved accounts. So
the app only applies bundles **signed with your bundle signing key**:

- The key is an ECDSA P-256 key. CI passes it to the Docker build as the BuildKit secret `bundle_key` (GitHub
  secret `APP_BUNDLE_SIGNING_KEY`). The signature covers `version`, `checksum` and `minVersionCode`.
- The app verifies it with the public key in `client/src/lib/app-release.ts` (`BUNDLE_PUBLIC_KEY`) before it
  downloads anything; the plugin then checks the zip against the signed checksum.
- Images built without the secret (local builds, fork PRs, someone else's build) have `signature: null`, and
  apps keep the UI they have. Any server that runs your published image works.

### The native baseline

A UI bundle may only run on an APK with the native code it was built for. `client/native-baseline.json`
records `{ minVersionCode, hash }`, where the hash covers `client/android` (files in git),
`client/capacitor.config.ts` and the installed versions of the native plugins.

- CI's `test` job runs `node scripts/native-baseline.mjs --check` and fails when the hash changed.
- Then run `node scripts/native-baseline.mjs --bump <versionCode>` with the versionCode of the release that
  ships the new native code (e.g. `--bump 10300` for `v1.3.0`), commit, and release that tag.
- An app older than `minVersionCode` keeps its UI and shows the banner: the server's newest features need the
  app update (on the Play build: update from Google Play).

Dependabot bumps of Capacitor plugins change the hash too, so they need a bump and an APK release.

## APK updates

- `client/src/lib/apk-update.ts` asks Zealot on start and on resume (at most every 6 hours):
  `GET /api/apps/latest?channel_key=…&bundle_id=dev.bootta.specharvest&release_version=…&build_version=…`, over
  native HTTP (no CORS needed). The Zealot URL and channel key are in `client/src/lib/app-release.ts`; they
  aren't secret (the key only reads that channel). The channel's downloads must be public.
- `UpdateBanner.tsx` shows the newer version with its changelog. **Later** hides it until a newer one.
- **Update** checks *Install unknown apps* for SpecHarvest (and opens that setting if needed), then the native
  `AppInstaller` plugin downloads the APK and installs it with Android's `PackageInstaller`. Android checks
  that it's signed with the same key as the installed app.
- **The first update** after installing from a browser always shows Android's confirm screen (the browser
  installed the app). After that, the app installed itself, so on Android 12+ later updates install without
  a confirm screen (`UPDATE_PACKAGES_WITHOUT_USER_ACTION`), unless Android decides to ask anyway.
- Android doesn't let an app reopen itself after updating, so a notification *SpecHarvest updated to X — tap
  to open* appears.

## The signing keys

Three keys, all made once and backed up (password manager + an offline copy):

| Key | Signs | Where it lives |
|---|---|---|
| App signing key | the direct APK; later uploaded to Play App Signing | `specharvest-release.jks`, outside the repo; GitHub secrets |
| Upload key | the Play bundle | `client/android/specharvest-upload.jks` ([Google Play, step 3](google-play.md#3-create-the-upload-key)) |
| Bundle signing key | live UI bundles | a PEM file outside the repo; GitHub secret |

**Losing the app signing key** means installed apps can never be updated again (users would have to
uninstall), so keep two backups.

### One-time setup

Do these in order, once. Keep every key **outside the repo** (here `~/keys`; the repo ignores `*.pem` and
`*.jks` as a safety net) and never paste a private key, password or token into a chat or an issue.

#### 1. Create the two keys

```bash
mkdir -p ~/keys && cd ~/keys

# App signing key: signs every APK. Asks for a password (twice) and a name/organization (any values).
/opt/homebrew/opt/openjdk@21/bin/keytool -genkeypair -v -keystore specharvest-release.jks \
  -alias specharvest -keyalg RSA -keysize 4096 -validity 10000

# Bundle signing key: signs the silent UI updates.
openssl ecparam -name prime256v1 -genkey -noout -out specharvest-bundle.pem
openssl pkey -in specharvest-bundle.pem -pubout     # prints the PUBLIC key, needed in step 3
```

Right away, save `specharvest-release.jks` with its password and `specharvest-bundle.pem` in your password
manager, plus an offline copy. For local release builds, copy `client/android/app-signing.properties.example`
to `app-signing.properties` (git-ignored) and fill it in.

#### 2. Zealot (`https://apps.bootta.dev`)

1. Create the app **SpecHarvest** with an **Android** channel, and make the channel's downloads public.
2. Open the channel and copy its **channel key**.
3. In your user **Settings → API token**, copy the **token**.

#### 3. Put the public values into the app

In `client/src/lib/app-release.ts`, set `BUNDLE_PUBLIC_KEY` to the public key from step 1 and
`ZEALOT_CHANNEL_KEY` to the channel key from step 2. Neither is secret.

#### 4. The GitHub environment

*Settings → Environments → New environment* `android-release`:

- **Deployment branches and tags:** *Selected branches and tags* → *Add deployment branch or tag rule* →
  type **Tag**, pattern `v*`. It shows "applies to 0 tags" until the first tag exists.
- Required reviewers are optional: with them, every release waits for your approval.

#### 5. Environment secrets and variable

Run in the repo folder, so `gh` picks this repository. Each `gh secret set` asks for the value and hides it.

```bash
base64 -i ~/keys/specharvest-release.jks | gh secret set ANDROID_KEYSTORE_BASE64 --env android-release
gh secret set ANDROID_KEYSTORE_PASSWORD --env android-release   # keystore password from step 1
gh secret set ANDROID_KEY_ALIAS --env android-release           # specharvest
gh secret set ANDROID_KEY_PASSWORD --env android-release        # key password (same as the keystore one if you pressed Enter)
gh secret set ZEALOT_API_TOKEN --env android-release            # token from step 2
gh variable set ZEALOT_CHANNEL_KEY --env android-release        # channel key from step 2 (a variable, not a secret)
```

On the web: the environment's page → *Environment secrets → Add environment secret* (for
`ANDROID_KEYSTORE_BASE64` paste the output of `base64 -i ~/keys/specharvest-release.jks`), and
`ZEALOT_CHANNEL_KEY` under *Environment variables → Add variable*.

Once the app goes to Google Play (the upload key from [Google Play, step 3](google-play.md#3-create-the-upload-key)),
add the upload key too. Until then CI skips the Play bundle.

```bash
base64 -i client/android/specharvest-upload.jks | gh secret set ANDROID_UPLOAD_KEYSTORE_BASE64 --env android-release
gh secret set ANDROID_UPLOAD_KEYSTORE_PASSWORD --env android-release
gh secret set ANDROID_UPLOAD_KEY_ALIAS --env android-release  # upload
gh secret set ANDROID_UPLOAD_KEY_PASSWORD --env android-release
```

#### 6. The repository secret

A repository secret, not an environment one, because the server image is built on every push, not only
on tags:

```bash
gh secret set APP_BUNDLE_SIGNING_KEY < ~/keys/specharvest-bundle.pem
```

Pass the file with `<`. Don't paste the key at `gh`'s prompt: the prompt keeps only the first line, and the
image build then fails with "The bundle signing key isn't a valid PEM private key".

On the web: *Settings → Secrets and variables → Actions → New repository secret*, and paste the whole file,
`BEGIN` and `END` lines included.

#### 7. Check

```bash
gh secret list --env android-release    # 5 secrets (9 with the upload key)
gh variable list --env android-release  # ZEALOT_CHANNEL_KEY
gh secret list                          # APP_BUNDLE_SIGNING_KEY
```

#### 8. First release

Commit `app-release.ts` and push the first tag (see [Releasing](#releasing)), e.g. `v0.1.0`. Install that
APK from Zealot on the phones; uninstall a debug build first, since it's signed with a different key.

**Changing the bundle signing key later** (e.g. after a leak): update `APP_BUNDLE_SIGNING_KEY` and
`BUNDLE_PUBLIC_KEY` together and release a new APK. Apps still on the old APK ignore the new signatures
and keep their UI until they install it.
