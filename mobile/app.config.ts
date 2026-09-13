import type { ExpoConfig, ConfigContext } from "expo/config";

/**
 * Expo config.
 *
 * Environment comes from EXPO_PUBLIC_* variables in mobile/.env, which Expo
 * loads automatically. They are surfaced through `extra` so a single typed
 * accessor (src/lib/supabase.ts) reads them, rather than scattering
 * process.env lookups through the app.
 *
 * NOTE ON "PUBLIC": EXPO_PUBLIC_* values are embedded in the app bundle and are
 * readable by anyone with the APK. That is correct for every one of them — the
 * API base URL, the Supabase project URL, the Supabase *publishable* (anon)
 * key and the web app's own origin are all designed to be client-visible. The
 * service-role key is never in this app; it stays server-side.
 */

/**
 * The web host the confirmation email now points at, or null.
 *
 * WHY THE APP CARES ABOUT A WEBSITE'S HOSTNAME. Confirmation emails redirect to
 * `${WEB_APP_URL}/auth/confirm` for every owner, web- and mobile-registered
 * alike, because a `finsight://` link in an inbox is a dead end on any device
 * that does not have the app. The OS hands an https link to the app instead of
 * the browser only when the app CLAIMS that host — an Android App Link with
 * `autoVerify`, an iOS Universal Link with an associated domain — which is what
 * the two blocks below declare.
 *
 * NULL WHEN UNSET OR NOT https, and then nothing is emitted at all. A claim on
 * a placeholder host is worse than no claim: Android's verifier fails it and
 * the link stops opening the app for good on that install, and local dev (where
 * this is a LAN address, not a domain anybody can serve a file from) would
 * otherwise ship a broken association into every debug build. Existing builds
 * are likewise unaffected.
 *
 * VERIFICATION IS A DEPLOYMENT STEP, NOT A CODE ONE. This half is the app's
 * claim; the other half is the host serving `/.well-known/assetlinks.json` with
 * this package's signing-certificate fingerprint and
 * `/.well-known/apple-app-site-association` with the app ID. Until both are
 * live the link opens the website, which is exactly why the site can hand the
 * session back over `finsight://auth/handoff` (see AuthScreens.tsx).
 */
const webAppHost = (() => {
  const raw = process.env.EXPO_PUBLIC_WEB_APP_URL;
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && url.hostname ? url.hostname : null;
  } catch {
    // A malformed value is a typo in an env file, not a reason to fail the
    // build — it just means no association, same as unset.
    return null;
  }
})();

const apiBaseUrl = process.env.EXPO_PUBLIC_API_BASE_URL;
const apiUsesCleartext = (() => {
  if (!apiBaseUrl) return false;
  try {
    return new URL(apiBaseUrl).protocol === "http:";
  } catch {
    return false;
  }
})();

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: "FinSight",
  slug: "finsight",
  /*
   * KEPT, even though confirmation emails no longer use it. Password reset
   * still arrives on `finsight://`, and so does the website's hand-back of a
   * session (`finsight://auth/handoff?code=…`) — a custom scheme is the only
   * way a browser can open this app on a device where the App Link claim
   * below has not verified.
   */
  scheme: "finsight",
  version: "0.1.0",
  orientation: "portrait",
  /*
   * AUTOMATIC, not forced Light.
   *
   * This is the NATIVE side of the appearance preference — it decides what
   * colour the OS paints the things the app does not draw itself: the system
   * keyboard, native alerts, the scroll indicators, the text-selection menus.
   * Pinning it to "light" meant an owner on a dark phone got a white keyboard
   * under a dark app. "automatic" lets those follow the device.
   *
   * It does NOT control the app's own palette. That is still the owner's
   * choice in Settings → Appearance, which now has a third option ("Use
   * device setting") that reads the same system value through
   * `Appearance.getColorScheme()`. See src/context/ThemeContext.tsx.
   */
  userInterfaceStyle: "automatic",

  /*
   * LAUNCH ART. All of it is derived from assets/mascot/finsightlogo.png —
   * the same owl badge the web app adopted — by scripts run once at authoring
   * time, not at build time. See the "assets" section of assets/README.md.
   *
   * `icon` is the iOS/store icon: opaque (iOS rejects alpha), the badge at
   * 78% of the canvas so no launcher mask clips the ring.
   */
  icon: "./assets/icon.png",

  android: {
    package: "app.finsight.mobile",
    adaptiveIcon: {
      // The badge sits at 62% of the foreground canvas, inside the 66% safe
      // zone every launcher mask is guaranteed to show, so a circle, a
      // squircle and a teardrop all crop only the transparent margin.
      foregroundImage: "./assets/android-icon-foreground.png",
      // Same plate as the splash below, because on Android 12+ the system
      // splash IS this icon on that background — two different darks would
      // show as a visible square around the mark.
      backgroundColor: "#052624",
    },
    // Camera is requested at runtime by expo-camera (the receipt scanner) and
    // by expo-image-picker (the gallery fallback); declaring it here keeps the
    // manifest honest about what the app can do.
    permissions: ["CAMERA", "READ_EXTERNAL_STORAGE"],
    /*
     * The App Link claim, present only when there is a real host to claim.
     * Scoped to `/auth` rather than the whole site: the app has nothing to do
     * with the marketing pages, and a filter that swallowed every link to the
     * website would take the blog with it.
     */
    ...(webAppHost
      ? {
          intentFilters: [
            {
              action: "VIEW",
              autoVerify: true,
              category: ["BROWSABLE", "DEFAULT"],
              data: [{ scheme: "https", host: webAppHost, pathPrefix: "/auth" }],
            },
          ],
        }
      : {}),
  },
  ios: {
    bundleIdentifier: "app.finsight.mobile",
    // The iOS half of the same claim. Path scoping lives in the
    // apple-app-site-association file on the host, not here.
    ...(webAppHost ? { associatedDomains: [`applinks:${webAppHost}`] } : {}),
    /*
     * PHONE-FIRST, and said out loud rather than implied.
     *
     * Every layout in this app is a single column sized for a thumb, and the
     * orientation lock above is portrait. `supportsTablet: true` claimed an
     * iPad experience that does not exist — the App Store then shows the app
     * to iPad owners and screenshots it at iPad sizes. Turning the claim off
     * is the honest state until the maximum-content-width, two-pane and
     * landscape-chart work in the UI/UX plan §6 is actually done; iPhone apps
     * still run on iPad in compatibility mode, so nobody loses access.
     */
    supportsTablet: false,
    infoPlist: {
      NSCameraUsageDescription:
        "FinSight uses the camera so you can take a photo of a receipt instead of typing it in.",
      NSPhotoLibraryUsageDescription:
        "FinSight can read a receipt from a photo you have already taken.",
    },
  },
  web: { favicon: "./assets/favicon.png" },

  plugins: [
    // Preserve gallery launchers across accessibility font-size changes.
    "./plugins/withScannerFontScale",
    // Android blocks HTTP in release builds by default. Permit it only while
    // the configured development API is itself HTTP; HTTPS keeps the secure
    // platform default. `android:apk` prebuilds so this reaches the manifest.
    ["./plugins/withApiCleartext", { enabled: apiUsesCleartext }],
    // Splash moved out of the top-level `splash` key in SDK 54+; it is plugin
    // config now.
    [
      "expo-splash-screen",
      {
        image: "./assets/splash-icon.png",
        resizeMode: "contain",
        imageWidth: 160,
        /*
         * ONE FIXED BRAND SURFACE IN BOTH THEMES, deliberately, rather than a
         * light plate and a dark plate.
         *
         * The native splash is painted by the OS before any JavaScript runs,
         * so it cannot know which palette the owner chose — the preference
         * lives in SecureStore and is read asynchronously. A light splash
         * would therefore flash white at every Dark-mode owner on every cold
         * start. brand-950 is dark enough that the handover into either
         * palette is a change of shade, not a flash, and it is the same plate
         * as the adaptive icon above so Android 12+'s icon-on-background
         * splash has no seam.
         *
         * No `dark` variant for the same reason: two splashes keyed to the
         * SYSTEM scheme would disagree with an owner who picked Light on a
         * dark phone.
         */
        backgroundColor: "#052624", // brand-950
      },
    ],
    "expo-secure-store",
    "expo-font",
    [
      "expo-image-picker",
      {
        photosPermission: "FinSight can read a receipt from a photo you have already taken.",
        cameraPermission: "FinSight uses the camera so you can photograph a receipt instead of typing it in.",
        /*
         * This plugin adds RECORD_AUDIO to the Android manifest unless it is
         * told not to, and it has been doing so since it was added — a
         * bookkeeping app that has never recorded a second of audio was
         * shipping a microphone permission. `false` both skips it and BLOCKS
         * it, so no other plugin can put it back.
         */
        microphonePermission: false,
      },
    ],
    /*
     * The receipt scanner's own camera.
     *
     * `microphonePermission: false` because nothing here records video or
     * sound — a still photograph of a receipt is the entire feature — and
     * leaving the default on would put a microphone permission in the
     * manifest of a bookkeeping app for no reason anyone could defend.
     */
    [
      "expo-camera",
      {
        cameraPermission: "FinSight uses the camera so you can photograph a receipt instead of typing it in.",
        recordAudioAndroid: false,
        microphonePermission: false,
        // Nothing in FinSight scans barcodes, and leaving this on ships the
        // scanning support in the APK regardless.
        barcodeScannerEnabled: false,
      },
    ],
  ],

  extra: {
    apiBaseUrl,
    supabaseUrl: process.env.EXPO_PUBLIC_SUPABASE_URL,
    supabaseAnonKey: process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY,
    receiptScannerEnabled: process.env.EXPO_PUBLIC_RECEIPT_SCANNER_ENABLED !== "false",
    receiptCameraMode: process.env.EXPO_PUBLIC_RECEIPT_CAMERA_MODE === "native" ? "native" : "custom",
  },
});
