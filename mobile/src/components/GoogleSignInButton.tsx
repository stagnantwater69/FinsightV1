import { useState } from "react";
import { ActivityIndicator, Pressable, View } from "react-native";
import Svg, { Path } from "react-native-svg";
import { ErrorNote, T } from "./ui";
import { useAuth } from "../context/AuthContext";
import { useTheme } from "../context/ThemeContext";
import * as haptics from "../lib/haptics";
import { font, radius, space, typeScale } from "../theme/tokens";
import { TAP_FLOOR } from "./touchTarget";

/**
 * Google's "G", in Google's own four colours. A deliberate exception to the
 * palette: Google's sign-in branding rules require the mark unaltered, and a
 * recoloured G reads as a lookalike. Same paths as the web button.
 */
function GoogleMark() {
  return (
    <Svg width={20} height={20} viewBox="0 0 24 24">
      <Path fill="#4285F4" d="M21.6 12.2c0-.7-.1-1.4-.2-2.1H12v4h5.4a4.6 4.6 0 0 1-2 3v2.5h3.3c1.9-1.7 2.9-4.2 2.9-7.4Z" />
      <Path fill="#34A853" d="M12 22c2.7 0 5-.9 6.7-2.4l-3.3-2.5c-.9.6-2 1-3.4 1-2.6 0-4.8-1.8-5.6-4.2H3v2.6A10 10 0 0 0 12 22Z" />
      <Path fill="#FBBC05" d="M6.4 13.9a6 6 0 0 1 0-3.8V7.5H3a10 10 0 0 0 0 9l3.4-2.6Z" />
      <Path fill="#EA4335" d="M12 5.9c1.5 0 2.8.5 3.8 1.5l2.9-2.8A9.6 9.6 0 0 0 12 2a10 10 0 0 0-9 5.5l3.4 2.6C7.2 7.7 9.4 5.9 12 5.9Z" />
    </Svg>
  );
}

function Divider({ label }: { label: string }) {
  const t = useTheme();
  return (
    <View
      // Decoration: the button and the form already say what they are.
      aria-hidden
      style={{ flexDirection: "row", alignItems: "center", gap: space.md }}
    >
      <View style={{ flex: 1, height: 1, backgroundColor: t.border }} />
      <T variant="caption">{label}</T>
      <View style={{ flex: 1, height: 1, backgroundColor: t.border }} />
    </View>
  );
}

/**
 * "Continue with Google", with the divider that separates it from the email
 * form. Before the form on Register, after it on Login, matching web.
 *
 * Signing in is all AuthContext.loginWithGoogle; this only shows progress and
 * the outcome. Closing Google's sheet is a choice, not a failure, so it shows
 * nothing.
 */
export function GoogleSignInButton({
  disabled = false,
  placement = "before-email",
}: {
  disabled?: boolean;
  placement?: "before-email" | "after-email";
}) {
  const t = useTheme();
  const { loginWithGoogle } = useAuth();
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inactive = disabled || starting;

  async function start() {
    if (inactive) return;
    haptics.tapped();
    setStarting(true);
    setError(null);
    const result = await loginWithGoogle().catch(() => ({
      status: "failed" as const,
      message: "Google sign-in couldn't start. Try again, or use your email and password.",
    }));
    // A successful sign-in unmounts this screen; only the other outcomes return here.
    if (result.status === "failed") {
      setError(result.message);
      haptics.failed();
    }
    if (result.status !== "signed-in") setStarting(false);
  }

  return (
    <View style={{ gap: space.md, marginTop: placement === "after-email" ? space.lg : 0, marginBottom: placement === "before-email" ? space.lg : 0 }}>
      {placement === "after-email" ? <Divider label="or" /> : null}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={starting ? "Opening Google" : "Continue with Google"}
        accessibilityState={{ disabled: inactive, busy: starting }}
        disabled={inactive}
        onPress={() => void start()}
        style={({ pressed }) => ({
          minHeight: TAP_FLOOR + 4,
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "center",
          gap: space.sm,
          paddingHorizontal: space.lg,
          borderRadius: radius.md,
          borderWidth: 1,
          borderColor: t.borderStrong,
          backgroundColor: pressed ? t.surfaceMuted : t.surface,
          opacity: disabled && !starting ? 0.55 : 1,
        })}
      >
        {starting ? <ActivityIndicator size="small" color={t.brandText} /> : <GoogleMark />}
        <T style={{ fontFamily: font.sansSemibold, fontSize: typeScale.body, color: t.textPrimary }}>
          {starting ? "Opening Google…" : "Continue with Google"}
        </T>
      </Pressable>
      {error ? <ErrorNote>{error}</ErrorNote> : null}
      {placement === "before-email" ? <Divider label="or use email" /> : null}
    </View>
  );
}
