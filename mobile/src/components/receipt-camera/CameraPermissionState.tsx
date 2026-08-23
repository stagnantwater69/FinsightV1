import { ActivityIndicator, Image, Linking, View } from "react-native";
import { Button, T } from "../ui";
import { space, typeScale } from "../../theme/tokens";
import { useTheme } from "../../context/ThemeContext";

/**
 * What the camera screen shows when there is no camera to show.
 *
 * THREE STATES, not two, and the difference matters. Expo reports permission
 * as null while it is still working out what the answer is; treating that as
 * "denied" puts a "you refused access" screen in front of an owner who has
 * refused nothing, and treating it as "granted" mounts a preview against a
 * permission that may be about to be refused. So: null renders a wait,
 * `granted: false` with `canAskAgain` renders a request, and a hard denial
 * renders the route to Settings, because at that point the in-app prompt will
 * never appear again and asking someone to tap a button that does nothing is
 * worse than saying where the switch actually is.
 *
 * Every state keeps a way out. Gallery upload does not need the camera and
 * has always been the fallback — an owner who will not grant camera access
 * must still be able to scan a receipt they have already photographed.
 */
export function CameraPermissionState({
  status,
  onRequest,
  onPickFromGallery,
  onClose,
}: {
  status: "pending" | "denied" | "blocked";
  onRequest: () => void;
  onPickFromGallery: () => void;
  onClose: () => void;
}) {
  const t = useTheme();
  const { brand } = t;
  if (status === "pending") {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: t.cameraSurface }}>
        <ActivityIndicator color={brand[400]} />
        <T style={{ color: "rgba(255,255,255,0.7)", marginTop: space.md, fontSize: typeScale.label }}>
          Opening the camera…
        </T>
      </View>
    );
  }

  const blocked = status === "blocked";

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
      <Image
        source={require("../../../assets/mascot/01-onboarding/permission.png")}
        style={{ width: 96, height: 96 }}
        resizeMode="contain"
        accessibilityIgnoresInvertColors
      />

      <T variant="title" style={{ color: t.onCamera, textAlign: "center" }}>
        FinSight needs the camera
      </T>

      <T style={{ color: "rgba(255,255,255,0.72)", fontSize: 13.5, lineHeight: 20, textAlign: "center" }}>
        {blocked
          ? "Camera access is turned off for FinSight. You can switch it back on in Settings, or scan a photo you already have."
          : "It is used only to photograph a receipt, and the photo goes nowhere until you tap Scan."}
      </T>

      <View style={{ alignSelf: "stretch", gap: space.sm, marginTop: space.sm }}>
        {blocked ? (
          <Button title="Open Settings" variant="primary" onPress={() => void Linking.openSettings()} />
        ) : (
          <Button title="Allow camera access" variant="primary" onPress={onRequest} />
        )}
        <Button title="Choose from gallery instead" variant="secondary" onPress={onPickFromGallery} />
        <Button title="Cancel" variant="ghost" onPress={onClose} />
      </View>
    </View>
  );
}
