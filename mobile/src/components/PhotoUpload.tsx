import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Image, Pressable, View } from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import * as ImagePicker from "expo-image-picker";
import { ErrorNote, T } from "./ui";
import { api, errorMessage } from "../lib/api";
import { font, radius, space, typeScale } from "../theme/tokens";
import { useTheme } from "../context/ThemeContext";
import { TAP_FLOOR } from "./touchTarget";

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
  appearance = "default",
  initials,
  disabled = false,
  onBusyChange,
}: {
  /** The current image, or null when none is set. */
  url: string | null;
  /** Where the multipart POST goes. */
  endpoint: string;
  label: string;
  shape?: "circle" | "square";
  onUploaded: (updated: unknown) => void;
  appearance?: "default" | "account";
  initials?: string;
  disabled?: boolean;
  onBusyChange?: (busy: boolean) => void;
}) {
  const t = useTheme();
  const { brand, ink, paper } = t;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);

  const size = 72;

  async function pick() {
    if (pending.current || disabled) return;
    pending.current = true;
    setBusy(true);
    onBusyChange?.(true);
    setError(null);
    try {
      const res = await ImagePicker.launchImageLibraryAsync({
        quality: 0.7,
        mediaTypes: ["images"],
        allowsEditing: true,
        aspect: [1, 1],
      });
      if (res.canceled || !res.assets[0] || !active.current) return;
      const asset = res.assets[0];
      const form = new FormData();
      // React Native's FormData takes this {uri,name,type} shape rather than a
      // Blob — the browser's File API does not exist here.
      form.append("file", {
        uri: asset.uri,
        name: asset.fileName ?? `photo-${Date.now()}.jpg`,
        type: asset.mimeType ?? "image/jpeg",
      } as any);
      const updated = await api.upload(endpoint, form);
      if (active.current) onUploaded(updated);
    } catch (err) {
      if (active.current) setError(errorMessage(err));
    } finally {
      pending.current = false;
      if (active.current) {
        setBusy(false);
        onBusyChange?.(false);
      }
    }
  }

  if (appearance === "account") {
    return (
      <View style={{ marginBottom: space.sm }}>
        <Pressable onPress={() => void pick()} disabled={busy || disabled} accessibilityRole="button"
          accessibilityLabel={url ? `Change ${label}` : `Add ${label}`}
          accessibilityState={{ disabled: busy || disabled, busy }}
          style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: space.lg, minHeight: TAP_FLOOR, padding: space.lg, borderRadius: radius.md, backgroundColor: t.brandSurface, opacity: busy || disabled ? 0.65 : pressed ? 0.8 : 1 })}>
          <View style={{ width: size, height: size, borderRadius: radius.full, backgroundColor: t.brandBorder, alignItems: "center", justifyContent: "center", overflow: "hidden" }}>
            {busy ? <ActivityIndicator color={t.brandText} /> : url ? <Image source={{ uri: url }} style={{ width: size, height: size }} accessibilityIgnoresInvertColors /> : <T style={{ color: t.brandHeading, fontSize: typeScale.title, fontFamily: font.displayBold }}>{initials || "?"}</T>}
          </View>
          <View style={{ flex: 1, gap: space.sm }}>
            <T style={{ color: t.textPrimary, fontFamily: font.sansSemibold }}>{label}</T>
            <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
              <Ionicons name="image-outline" size={22} color={t.brandText} accessibilityElementsHidden importantForAccessibility="no" />
              <T style={{ flex: 1, color: t.brandText, fontSize: typeScale.bodySm, fontFamily: font.sansSemibold }}>{busy ? "Uploading..." : url ? "Change photo" : "Choose a photo"}</T>
            </View>
          </View>
        </Pressable>
        {error ? <ErrorNote>{error}</ErrorNote> : null}
      </View>
    );
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
              // RN only sets `accessible` on an Image when `alt` is given;
              // an `accessibilityLabel` alone leaves it a non-element and the
              // label unread. Same class of defect as a View carrying a role
              // without `accessible`.
              accessible
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
            disabled={busy || disabled}
            accessibilityRole="button"
            accessibilityLabel={url ? `Change ${label}` : `Add ${label}`}
            accessibilityState={{ disabled: busy || disabled, busy }}
            style={{ minHeight: TAP_FLOOR, justifyContent: "center", paddingVertical: space.sm, opacity: busy || disabled ? 0.5 : 1 }}
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
