/**
 * Release settings the Android app is built with (docs/app-updates.md). None of these are secret: the channel key
 * only reads that Zealot channel, and the public key only verifies UI bundles.
 */

/** Zealot, where the direct APK is released; the app asks it for newer builds (lib/apk-update.ts). */
export const ZEALOT_URL = "https://apps.bootta.dev";

/** The Zealot channel the direct APK is uploaded to. Empty: the app doesn't look for APK updates. */
export const ZEALOT_CHANNEL_KEY = "6d70c822b491f288397754d587051990";

/**
 * Verifies live UI bundles (lib/updates.ts): the public half of APP_BUNDLE_SIGNING_KEY, an ECDSA P-256 key, as PEM
 * or its base64 body. Empty: the app never applies a UI bundle.
 */
export const BUNDLE_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEhjhyPlkaIGGV7UpCOvshyYNeET9Z
Vo6DCzCDon+l7ucvea6j+s7gbtvVQrlx/VvCx31QsapOe/t5krARX9ME3g==
-----END PUBLIC KEY-----`;
