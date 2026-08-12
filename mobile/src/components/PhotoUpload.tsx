import { useState } from "react";
import { ActivityIndicator, Image, Pressable, View } from "react-native";
import * as ImagePicker from "expo-image-picker";
import { ErrorNote, T } from "./ui";
import { api, errorMessage } from "../lib/api";
import { brand, ink, paper, radius, space, typeScale } from "../theme/tokens";

/**
 * Choosing a profile photo or a business logo.
 *
 * The endpoints have existed since before mobile had any way to reach them,
 * so a phone could show an avatar the owner set on the web app but never set
 * one — which is the wrong way round, given the phone is where the camera is.
 *
 * Gallery only, deliberately. A logo is almost always an existing image file,
 * and a profile photo taken on the spot is a nice-to-have that would mean a
 * second permission prompt on a screen that is not about the camera.
 */
export function PhotoUpload({
  url,
  endpoint,
  label,
  shape = "circle",
  onUploaded,
}: {
  /** The current image, or null when none is set. */
  url: string | null;
  /** Where the multipart POST goes. */
  endpoint: string;
  label: string;
  shape?: "circle" | "square";
  onUploaded: (updated: unknown) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const size = 72;

  async function pick() {
    setError(null);
    const res = await ImagePicker.launchImageLibraryAsync({
      quality: 0.7,
      mediaTypes: ["images"],
      allowsEditing: true,
      aspect: [1, 1],
    });
    if (res.canceled || !res.assets[0]) return;

    const asset = res.assets[0];
    setBusy(true);
    try {
      const form = new FormData();
      // React Native's FormData takes this {uri,name,type} shape rather than a
      // Blob — the browser's File API does not exist here.
      form.append("file", {
        uri: asset.uri,
        name: asset.fileName ?? `photo-${Date.now()}.jpg`,
        type: asset.mimeType ?? "image/jpeg",
      } as any);
      onUploaded(await api.upload(endpoint, form));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={{ marginBottom: space.md }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.md }}>
        <View
          style={{
            width: size,
            height: size,
            borderRadius: shape === "circle" ? size / 2 : radius.md,
            backgroundColor: paper[100],
            borderWidth: 1,
            borderColor: ink[200],
            alignItems: "center",
            justifyContent: "center",
            overflow: "hidden",
          }}
        >
          {/*
            This box is the field's current value, so whatever is in it says
            which field it belongs to. `label` is the caller's own word for
            that — "Business logo" or "Profile photo" — and it is the only
            thing that tells the two apart, since the component itself cannot
            know which one it is rendering.
          */}
          {busy ? (
            <ActivityIndicator color={brand[600]} />
          ) : url ? (
            <Image
              source={{ uri: url }}
              style={{ width: size, height: size }}
              accessibilityRole="image"
              accessibilityLabel={label}
              accessibilityIgnoresInvertColors
            />
          ) : (
            <T variant="caption" style={{ color: ink[400] }} accessibilityLabel={`${label}, none set`}>
              None
            </T>
          )}
        </View>

        <View style={{ flex: 1 }}>
          {/*
            Silent to a screen reader, and deliberately. The three things in
            this row sit next to each other, and two of them already carry the
            label: the image on the left announces it as the current value, the
            button below announces it as "Change Business logo". Read out as
            well, this line makes the same two words the third thing in a row a
            reader hears, and it is the one of the three that adds nothing —
            it exists so a sighted owner can see the field's name.
          */}
          <T
            variant="label"
            style={{ color: ink[700] }}
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
          >
            {label}
          </T>
          <Pressable
            onPress={pick}
            disabled={busy}
            accessibilityRole="button"
            accessibilityLabel={url ? `Change ${label}` : `Add ${label}`}
            style={{ paddingVertical: space.sm, opacity: busy ? 0.5 : 1 }}
          >
            <T style={{ color: brand[700], fontSize: typeScale.bodySm }}>
              {busy ? "Uploading…" : url ? "Change photo" : "Choose a photo"}
            </T>
          </Pressable>
        </View>
      </View>
      {error ? <ErrorNote>{error}</ErrorNote> : null}
    </View>
  );
}
