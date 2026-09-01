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
 * readable by anyone with the APK. That is correct for all three of these — the
 * API base URL, the Supabase project URL, and the Supabase *publishable*
 * (anon) key are all designed to be client-visible. The service-role key is
 * never in this app; it stays server-side.
 */
export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: "FinSight",
  slug: "finsight",
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
  },
  ios: {
    bundleIdentifier: "app.finsight.mobile",
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
    // Splash moved out of the top-level `splash` key in SDK 54+; it is plugin
    // config now.
    [
      "expo-splash-screen",
      {
        image: "./assets/splash-icon.png",
        resizeMode: "contain",
        imageWidth: 220,
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
    apiBaseUrl: process.env.EXPO_PUBLIC_API_BASE_URL,
    supabaseUrl: process.env.EXPO_PUBLIC_SUPABASE_URL,
    supabaseAnonKey: process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY,
    receiptScannerEnabled: process.env.EXPO_PUBLIC_RECEIPT_SCANNER_ENABLED !== "false",
  },
});
