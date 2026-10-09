# Project notes

## Updating the Android app

When asked to update/install the Android app (`client/android`, see `docs/mobile-app.md`) after making
changes, prefer installing over wireless debugging (adb-over-wifi) rather than suggesting Android
Studio, USB, or a manual APK transfer.

1. Check for a wirelessly-connected device:
   ```bash
   adb devices -l
   ```
   A device listed with a `._adb-tls-connect._tcp` transport (not a USB serial) is connected via
   wireless debugging.
2. Build and sync the web assets into the Android project:
   ```bash
   npm run cap:sync --workspace client
   ```
3. Build the debug APK. JDK 21 is required but may not be the default `java_home`:
   ```bash
   cd client/android
   JAVA_HOME=/opt/homebrew/opt/openjdk@21 ./gradlew assembleDebug
   ```
4. Install directly to the wirelessly-connected device:
   ```bash
   adb -s <device-id-from-step-1> install -r app/build/outputs/apk/debug/app-debug.apk
   ```

Only fall back to other install methods if no wirelessly-debugging device is found in step 1.
