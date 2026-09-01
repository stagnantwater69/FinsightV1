import { ActivityIndicator, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Button, T } from "../ui";
import { Mascot } from "../MascotState";
import { space, typeScale } from "../../theme/tokens";
import { useTheme } from "../../context/ThemeContext";

/**
 * The full-screen states ML Kit's launch can be in, before it hands control
 * back to FinSight with pages.
 *
 * ML Kit IS THE ONLY CAPTURE PATH THESE STATES SERVE. None of the three
 * offers a way into a camera FinSight draws itself — there is no such camera
 * left in this journey. `onGoBack`/`onCancel` are the only exits besides a
 * successful scan, and they all resolve to the same thing: close this screen
 * and leave the owner exactly where they were, the same contract
 * `ReceiptCamera`'s `onCancel` has always had.
 */

/** Shown the instant the screen mounts, while the platform scanner opens. */
export function ScannerLaunchingState() {
  const t = useTheme();
  return (
    <View
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel="Opening the automatic receipt scanner"
      accessibilityLiveRegion="polite"
      style={{
        flex: 1,
        alignItems: "center",
        justifyContent: "center",
        gap: space.md,
        paddingHorizontal: space.xl,
        backgroundColor: t.cameraSurface,
      }}
    >
      <ActivityIndicator size="large" color={t.brand[400]} />
      <T variant="title" style={{ color: t.onCamera, textAlign: "center" }}>
        Opening the scanner
      </T>
      <T style={{ color: "rgba(255,255,255,0.68)", textAlign: "center", lineHeight: 21 }}>
        It will find the receipt, remove the background, and straighten each page automatically.
      </T>
    </View>
  );
}

/**
 * The runtime cannot run ML Kit at all: Expo Go, iOS (deliberately deferred),
 * or the feature flag turned off.
 *
 * WHY THIS DOES NOT OFFER A CAMERA. A phone running Expo Go has no Nitro
 * module to open — attempting a fallback camera here would be exactly the
 * "silently switch capture implementations" behaviour this replacement
 * removes. Gallery import is not offered from inside this state either: it
 * already exists as its own explicitly-chosen action on the screen behind
 * this one (see ScanReceiptScreen's "Choose from gallery" button), and
 * surfacing it here would make it read as this flow's fallback rather than
 * the separate workflow it is.
 */
export function ScannerUnsupportedState({ onCancel }: { onCancel: () => void }) {
  const t = useTheme();
  return (
    <View
      style={{
        flex: 1,
        backgroundColor: t.cameraSurface,
        alignItems: "center",
        justifyContent: "center",
        padding: space.xl,
        gap: space.md,
      }}
    >
      <Mascot state="cameraPermission" size={96} />
      <T variant="title" style={{ color: t.onCamera, textAlign: "center" }}>
        A native FinSight build is required
      </T>
      <T style={{ color: "rgba(255,255,255,0.72)", fontSize: typeScale.label, lineHeight: 20, textAlign: "center" }}>
        FinSight's receipt scanner runs on Google ML Kit, which needs a native Android build of the app —
        it cannot open inside Expo Go, and it is not yet available on iOS. Use "Choose from gallery" on the
        previous screen for a photo you already have.
      </T>
      <View style={{ alignSelf: "stretch", marginTop: space.sm }}>
        <Button title="Go back" variant="secondary" onPress={onCancel} />
      </View>
    </View>
  );
}

/**
 * A genuine scanner failure — the scanner opened (or tried to) and did not
 * come back with a usable result for a reason that is not the owner
 * cancelling.
 *
 * States plainly what failed, and offers exactly the two things requirement 2
 * asks for: retry the same scanner, or go back. Neither button opens
 * anything else.
 */
export function ScannerFailureState({
  message,
  onRetry,
  onGoBack,
}: {
  message: string;
  onRetry: () => void;
  onGoBack: () => void;
}) {
  const t = useTheme();
  return (
    <View
      style={{
        flex: 1,
        backgroundColor: t.cameraSurface,
        alignItems: "center",
        justifyContent: "center",
        padding: space.xl,
        gap: space.md,
      }}
    >
      <View
        style={{
          width: 64,
          height: 64,
          borderRadius: 32,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: "rgba(226,72,72,0.16)",
        }}
      >
        <Ionicons name="warning-outline" size={30} color={t.statusSolid.critical} />
      </View>
      <T variant="title" style={{ color: t.onCamera, textAlign: "center" }}>
        The scanner couldn't finish
      </T>
      <T
        style={{ color: "rgba(255,255,255,0.72)", fontSize: typeScale.body, lineHeight: 20, textAlign: "center" }}
        accessibilityLiveRegion="assertive"
      >
        {message}
      </T>
      <View style={{ alignSelf: "stretch", gap: space.sm, marginTop: space.sm }}>
        <Button title="Retry scanner" variant="primary" onPress={onRetry} />
        <Button title="Go back" variant="secondary" onPress={onGoBack} />
      </View>
    </View>
  );
}
