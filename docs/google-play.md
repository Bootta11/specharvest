# Publish the Android app on Google Play

A step-by-step guide for a first release, from "no developer account" to "SpecHarvest is live on Google
Play". You don't need to know Play Console beforehand. For building and installing the app on your own
phone, see [Android app](mobile-app.md).

Play Console's menus move around now and then. If a menu name here doesn't match, use the search box at the
top of Play Console. The settings themselves stay the same.

## 1. Before you start

**What it costs:** a one-time **US$25** registration fee. Publishing and updates are free after that.

**How long it takes** (plan for 3–4 weeks the first time):

| Step | Time |
|---|---|
| Developer account + identity check | a few hours to a few days |
| Setting up the app in Play Console | 1–2 hours |
| **Closed test with 12 testers for 14 days** (new personal accounts only, see [step 9](#9-test-it-testing-tracks)) | 14+ days |
| Google's review of the production release | hours to a few days (sometimes a week) |

**Checklist** (tick these off before you submit):

- [ ] A Google account you'll keep for good. The developer account is tied to it.
- [ ] A payment card for the $25 fee, and an ID document for the identity check.
- [ ] A contact email that users will see on the store page.
- [ ] The server running a SpecHarvest version with **Delete account** and the privacy page. Check that
      `https://specharvest.bootta.dev/privacy.html` opens.
- [ ] The privacy page's contact email filled in: replace both `CONTACT_EMAIL` in
      `client/public/privacy.html`, then redeploy ([deployment](deployment.md)).
- [ ] A demo account on the server for Google's reviewers ([step 6](#app-access)).
- [ ] 12 people with Android phones who'll install the test version and use it ([step 9](#9-test-it-testing-tracks)).
- [ ] JDK 21 and the Android SDK, as for the debug build ([Android app](mobile-app.md#build-and-install)).

## 2. Create the developer account

1. Go to [play.google.com/console/signup](https://play.google.com/console/signup) and sign in with the
   Google account you chose.
2. **Choose the account type:**
   - **Personal**: for one person. The quickest to set up, but it needs the 12-tester closed test before
     your first production release.
   - **Organization**: for a registered company. It needs a **D-U-N-S number** (free from
     [Dun & Bradstreet](https://www.dnb.com/duns-number.html), takes days to weeks) and a company website.
     It skips the 12-tester test.

   If you don't have a company, pick **Personal**.
3. Fill in the **developer name** (shown on the store under the app name), contact details and phone
   number. Google sends codes to verify the email and the phone.
4. Pay the $25 fee.
5. **Verify your identity**: upload an ID document when asked. Play Console's home page shows the status.
   You can set up the app while you wait, but you can't publish until it's done.
6. Answer the questions about your Android experience and how many apps you plan to publish. They don't
   change anything about your account.

Since 2026, Google also requires **developer verification** for Android apps. For apps on Play, Play Console
handles this: on the **Home** page, check that SpecHarvest shows as registered once you've created it, and
follow any prompt there.

## 3. Create the upload key

Every file you upload to Play must be signed with your **upload key**. Google then re-signs the app with its
own key for users ([step 8](#8-play-app-signing)). You make the upload key once and use it for every update.

1. Create the key (one command, run in `client/android`):
   ```bash
   cd client/android
   /opt/homebrew/opt/openjdk@21/bin/keytool -genkeypair -v \
     -keystore specharvest-upload.jks -alias upload \
     -keyalg RSA -keysize 2048 -validity 10000
   ```
   It asks for a **keystore password** (pick a long one), your name and organization (any values are fine;
   users never see them), and a key password (press Enter to reuse the keystore password).
2. Tell the build where the key is:
   ```bash
   cp keystore.properties.example keystore.properties
   ```
   Then open `client/android/keystore.properties` and put in your passwords:
   ```properties
   storeFile=specharvest-upload.jks
   storePassword=<your keystore password>
   keyAlias=upload
   keyPassword=<your key password>
   ```
   `storeFile` is relative to `client/android/`. Git ignores both `keystore.properties` and `*.jks`, so they
   never end up in the repository.
3. **Back them up now.** Put `specharvest-upload.jks` and both passwords in your password manager, and keep
   a second copy offline (a USB stick, for example). If you lose the upload key you can't ship updates
   until Google resets it, which takes days ([troubleshooting](#12-troubleshooting)).

## 4. Build the release bundle

Google Play wants an **Android App Bundle** (`.aab`), not an APK.

1. **Set the version** in `client/android/app/build.gradle`:
   ```groovy
   versionCode 1        // a whole number; +1 for every upload, never reused
   versionName "1.0"    // what users see, e.g. "1.0", "1.1"
   ```
   Leave them as they are for the first upload.
2. **Build:**
   ```bash
   JAVA_HOME=/opt/homebrew/opt/openjdk@21 npm run android:bundle --workspace client
   ```
   This builds the web UI, copies it into the Android project and builds a signed release bundle:
   `client/android/app/build/outputs/bundle/release/app-release.aab`
3. **Check that it's signed with your upload key:**
   ```bash
   /opt/homebrew/opt/openjdk@21/bin/keytool -printcert -jarfile client/android/app/build/outputs/bundle/release/app-release.aab
   ```
   It should print the name you entered in step 3. If it says the file isn't signed, `keystore.properties` is
   missing or in the wrong place (it belongs in `client/android/`).

You can't install an `.aab` directly. To try the real thing on your phone, use the internal testing track
([step 9](#9-test-it-testing-tracks)). Uninstall the debug build from the phone first. It's signed with a
different key, so Android won't install the Play version over it.

## 5. Create the app in Play Console

1. Open [Play Console](https://play.google.com/console) → **Create app**.
2. Fill in:
   - **App name:** `SpecHarvest` (30 characters max; you can change it later)
   - **Default language:** English (United States), or your main language
   - **App or game:** App
   - **Free or paid:** Free. *This can't be changed to paid later.*
3. Tick the declarations (Developer Program Policies, US export laws) and click **Create app**.

You land on the app's **Dashboard**, which lists everything left to do. The next steps work through it.

## 6. Set up your app (Dashboard tasks)

Open **Dashboard** → **Set up your app** and go through each task. Most are in **Policy → App content**.

### Privacy policy

- URL: `https://specharvest.bootta.dev/privacy.html`

The page lives in `client/public/privacy.html` and is served by the server. It's public, works on a phone,
and covers what the app stores, who sees it, and how to delete your account.

### App access

SpecHarvest can't be used without signing in, so reviewers need an account:

1. Choose **All or some functionality is restricted**.
2. Click **Add instructions** and fill in:
   - **Name:** Demo account
   - **Username / email:** a demo user you created on `specharvest.bootta.dev` (as an admin: account menu →
     **Admin dashboard** → *Users* → *Add a user*, see [users & access](auth.md))
   - **Password:** its password
   - **Other information:** "The app opens on the sign-in screen; keep the default server and sign in.
     Collections lists a sample collection; Search shows its products."
3. **Make the demo account work:** give it a small sample collection, and make sure it can use the server's
   AI key (admin dashboard → **Settings** → *Server LLM key*, see [LLM providers](llm-providers.md)) so a reviewer's
   test crawl doesn't fail. Don't delete or change this account while a review is running.

### Ads

- **No, my app does not contain ads.**

### Content rating

1. Click **Start questionnaire**, enter your email, and pick the category **All other app types**.
2. Answer honestly. For SpecHarvest that's **No** to violence, sexual content, language, controlled
   substances, gambling and the like. To "Can users interact or exchange content?" answer **Yes**: users
   can share collections with other users of the same server. Answer **No** to sharing location and to
   digital purchases.
3. Submit. You get ratings for every region (usually the lowest age rating).

### Target audience and content

- **Target age group:** 18 and over (13+ is fine too). **Don't** pick any under-13 group. That brings in
  the much stricter Families policy.
- **Appeal to children:** No.

### News apps

- **No**, it isn't a news app.

### Data safety

This form becomes the "Data safety" section of the store page. Answers for SpecHarvest, based on what the
server really stores (see the [privacy page](https://specharvest.bootta.dev/privacy.html), source in `client/public/privacy.html`, and
[architecture](architecture.md)):

**Overview questions**

| Question | Answer |
|---|---|
| Does your app collect or share any of the required user data types? | **Yes** |
| Is all of the user data collected by your app encrypted in transit? | **Yes** (HTTPS) |
| Which account creation methods does your app support? | **Username and password** (email + password) |
| Delete account URL | `https://specharvest.bootta.dev/privacy.html#delete-account` |
| Do you provide a way for users to request that some or all of their data is deleted, without requiring them to delete their account? | **No**. Deleting collections, keys and so on is possible in the app, but the full answer is "delete the account" |

**Data types** (tick only these):

| Category → type | Collected | Shared | Required or optional | Purposes |
|---|---|---|---|---|
| Personal info → **Email address** | Yes | No | Required | App functionality, Account management |
| Personal info → **User IDs** | Yes | No | Required | App functionality, Account management |
| App activity → **In-app search history** | Yes | No | Required | App functionality |
| App activity → **Other user-generated content** (collections, products) | Yes | No | Required | App functionality |

For each type, answer **No** to "processed ephemerally" (it's stored).

Why "Shared: No": Google doesn't count data sent to *service providers* that process it for you (the AI
provider reading a page, for example) as sharing. SpecHarvest has no ads, analytics or crash-reporting SDKs,
so there's nothing else to declare. If you add any later, update this form.

### Advertising ID

- **No**. The app doesn't use it.

### Government apps, financial features, health

- **No** to all three.

### Account deletion

If Play asks for it separately: `https://specharvest.bootta.dev/privacy.html#delete-account`. That section
explains the in-app steps (account menu → **Account & API keys** → *Delete account*) and gives an email for people who can't sign in any
more.

## 7. Store listing

Open **Grow users → Store presence → Main store listing**.

### Text

- **App name:** `SpecHarvest`
- **Short description** (80 characters max):
  > Turn shop listings into a searchable catalog of products and their specs.
- **Full description** (4000 characters max), a starting point:
  > SpecHarvest reads product listings from the online shops you pick and turns them into your own
  > searchable catalog, with every product's specifications side by side.
  >
  > • Paste or share a shop listing link: SpecHarvest walks all of its pages and reads each product.
  > • Search in plain language ("quiet 27-inch monitor under 300 €") and filter by any specification.
  > • Compare products in a table and spot the same product across shops.
  > • Fill in missing specs with a web lookup, only when you ask for it.
  > • Get a notification when a crawl finishes.
  > • Use the default server or your own self-hosted SpecHarvest server.
  >
  > Sign-in required. Your collections are private unless you share them.

### Graphics

| Asset | Size | Notes |
|---|---|---|
| **App icon** | 512 × 512 PNG, up to 1 MB | Export from `client/assets/icon-source.png` |
| **Feature graphic** | 1024 × 500 PNG or JPEG, no transparency | A banner: the icon and the name on the brand color `#0f766e` is enough |
| **Phone screenshots** | 2–8, PNG or JPEG, 16:9 or 9:16, 320–3840 px per side | Collections, a crawl in progress, search results, the compare table |

To make the icon (macOS):
```bash
sips -z 512 512 client/assets/icon-source.png --out play-icon-512.png
```

To take screenshots from your phone over wireless debugging (see [Android app](mobile-app.md#build-and-install)):
```bash
adb exec-out screencap -p > screenshot-1.png
```
Sign in with the demo account so no real data ends up on the store page.

### Category and contact

In **Store settings**: **App category** → *Productivity* (or *Shopping*), **Email address** → the contact
email, **Website** → `https://specharvest.bootta.dev`.

## 8. Play App Signing

On your first upload ([step 9](#9-test-it-testing-tracks)), Play asks about app signing. Keep the default,
**Google-generated key** (Play App Signing).

There are two keys:

- **Upload key**: yours, from [step 3](#3-create-the-upload-key). It proves to Google that an upload comes
  from you.
- **App signing key**: Google's. It signs what users install, and Google keeps it safe.

So if your upload key is ever lost or leaked, Google can reset it and users notice nothing. Without Play App
Signing, a lost key would mean you could never update the app again.

## 9. Test it (testing tracks)

### Internal testing (start here, instant)

1. **Test and release → Testing → Internal testing → Create new release.**
2. Accept Play App Signing ([step 8](#8-play-app-signing)) if asked.
3. Upload `app-release.aab`. The release name fills itself in (e.g. `1 (1.0)`). Add a line of release notes.
4. **Next → Save and publish.** There's no review for internal tests. It's ready in minutes.
5. **Testers** tab → create an email list with your own Google account (up to 100 people) → save.
6. Copy the **opt-in link**, open it on your phone (signed in to that Google account), accept, and install
   from Play. This is exactly what users will get.

### Closed testing (required for new personal accounts)

Personal accounts created after 13 November 2023 must run a closed test with **at least 12 testers who stay
opted in for 14 days in a row** before they can apply for production. Organization accounts skip this.

1. **Test and release → Testing → Closed testing → Create track** (or use the *Alpha* track).
2. **Countries/regions:** add the countries your testers are in.
3. **Testers:** add an email list or a Google Group with **at least 12** Google accounts (aim for 15–20 in
   case someone drops out).
4. **Create new release** → upload the same `.aab` (or a newer one with a higher `versionCode`) → **Send for
   review**. Closed tests are reviewed, which usually takes a few hours to a couple of days.
5. Once it's approved, send testers the **opt-in link** (Testers tab). Each tester must open it, tap
   **Become a tester**, and install the app from Play.
6. **Wait 14 days.** Testers must stay opted in the whole time. If the count drops below 12, the 14 days
   start over. Google also checks that testers really use the app, so ask them to sign in (the demo account
   or their own) and try a few things during those two weeks. Fix bugs they find and upload new versions as
   you go; that counts in your favor.
7. After 14 days, **Dashboard → Apply for production**. You answer a few questions (how you recruited
   testers, what you learned, what you changed). Google replies in about a week.

Tip: Google Groups is the easiest way to manage testers. Create a group, add the group's email address as the
tester list, and let people join the group.

## 10. Release to production

Once production access is granted (or straight away, for organization accounts):

1. **Test and release → Production → Countries/regions** → add where the app should be available (or
   *all countries*).
2. **Create new release** → **Add from library** to reuse the tested bundle, or upload a new `.aab`.
3. **Release notes**, e.g. `First release.`
4. **Rollout:** a **staged rollout** (say 20%) lets you catch problems before everyone gets the app. You can
   raise it to 100% any time.
5. **Next → Send changes for review** (under **Publishing overview**). Review usually takes hours to a few
   days.
6. Once it's approved, the app shows up on Play, usually within a few hours. Search for it on your phone.
   It can take a day before search finds it.

**Common reasons for rejection, and the fix:**

| Rejection | Fix |
|---|---|
| Reviewers couldn't sign in | The demo account in [App access](#app-access) is missing, expired or changed. Fix it and resubmit. |
| Missing account deletion | Check that the delete account URL opens and *Delete account* (account menu → **Account & API keys**) works on the live server. |
| Privacy policy not reachable / incomplete | Open the URL on a phone, signed out. The contact email must be filled in. |
| Data safety doesn't match what the app does | Go through [Data safety](#data-safety) again, and update it whenever the app changes. |
| Broken functionality | Test the exact uploaded build from the internal track before you submit. |

## 11. Ship an update

1. Make your changes and test them (see [Android app](mobile-app.md)).
2. Bump **`versionCode`** by 1 (required) and **`versionName`** (e.g. `1.0` → `1.1`) in
   `client/android/app/build.gradle`.
3. Build: `JAVA_HOME=/opt/homebrew/opt/openjdk@21 npm run android:bundle --workspace client`
4. Upload it on the internal track first, check it on your phone, then **Promote release** to production
   (or create a production release with the same bundle).

Changes that only touch the server (`server/`) don't need an app update. The app talks to the live server,
so they reach users once you deploy ([deployment](deployment.md)). The app needs an update when anything in
`client/` changes, because the UI ships inside the app.

## 12. Troubleshooting

| Problem | What to do |
|---|---|
| "Version code 1 has already been used" | Raise `versionCode` in `build.gradle` and build again. Every upload needs a new, higher number. |
| "The Android App Bundle was not signed" / "signed in debug mode" | `client/android/keystore.properties` is missing or wrong. Check it against [step 3](#3-create-the-upload-key) and rebuild. |
| "Your Android App Bundle is signed with the wrong key" | You built with a different keystore than the first upload. Use the original `.jks` from your backup. |
| Lost the upload key or its password | Play Console → **Test and release → App integrity → App signing** → **Request upload key reset**. Make a new key (step 3) and send Google its certificate as described there. It takes a few days. |
| "App must target Android 16 (API level 36) or higher" | `targetSdkVersion` lives in `client/android/variables.gradle` (currently 36). Google raises the minimum every August. Bump it and test. |
| Testers see "App not available" / "Item not found" | They must open the opt-in link signed in with the *same* Google account that's on the tester list, and the test release must be approved. Countries must include theirs. |
| Can't install over the debug build | Uninstall the debug app first. They're signed with different keys. |
| `keytool` / Gradle uses the wrong Java | Prefix commands with `JAVA_HOME=/opt/homebrew/opt/openjdk@21`, as above. |
