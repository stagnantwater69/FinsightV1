import { ActivityIndicator, Pressable, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { T } from "../ui";
import { TAP, font, radius, space, typeScale } from "../../theme/tokens";
import { useTheme } from "../../context/ThemeContext";

/**
 * The camera's chrome: the row above the preview and the row below it.
 *
 * COLOUR IS NOT DECORATIVE HERE, and the rules come from theme/tokens.ts
 * rather than from what looks good on a dark screen:
 *
 *   - the shutter wears `ACCENT.fill` with `ACCENT.onFill` on it, because the
 *     token file reserves amber for primary calls to action and capturing a
 *     section is unambiguously this screen's primary action;
 *   - "Finish" wears `brandFill` and NOT amber, even though it is also a
 *     call to action. Two amber controls on one screen means neither is the
 *     one thing to press, and the shutter has the better claim: an owner
 *     mid-receipt presses it several times and Finish once.
 *
 * Nothing here introduces a colour that is not already in the token file.
 *
 * THEME-INDEPENDENT, DELIBERATELY. Everything on this screen sits over live
 * video on a near-black plane (`cameraSurface`), which is the same in Light
 * and in Dark — a viewfinder is a lens, not a page. So the three washes below
 * stay literal, and the tokens used here are the ones that do not move
 * between themes: `ACCENT.fill`/`onFill`, `brandFill`/`onBrandFill`, and
 * `brand[400]`, which is the app's brand-on-a-dark-surface step in both.
 */

const CONTROL_BG = "rgba(26,32,34,0.55)";
const CONTROL_BORDER = "rgba(255,255,255,0.14)";
const ON_DARK = "rgba(255,255,255,0.92)";

export function CameraTopBar({
  onClose,
  sectionLabel,
  torchOn,
  onToggleTorch,
}: {
  onClose: () => void;
  sectionLabel: string;
  torchOn: boolean;
  onToggleTorch: () => void;
}) {
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        paddingHorizontal: space.md,
      }}
    >
      <RoundButton icon="close" label="Close the camera" onPress={onClose} />

      {/*
        Mono, because it is a counter. The app already reserves IBM Plex Mono
        for figures that have to sit still while the number beside them
        changes, and "Section 3 of 3" ticking upward mid-session is exactly
        that — a proportional face makes the whole pill jump width as it goes.
      */}
      <View
        style={{
          backgroundColor: "rgba(46,194,172,0.16)",
          borderWidth: 1,
          borderColor: "rgba(46,194,172,0.45)",
          borderRadius: radius.full,
          paddingHorizontal: 14,
          paddingVertical: 6,
        }}
      >
        <T style={{ fontFamily: font.monoMedium, fontSize: typeScale.caption, color: ON_DARK }}>{sectionLabel}</T>
      </View>

      <RoundButton
        icon={torchOn ? "flash" : "flash-off"}
        label={torchOn ? "Turn the light off" : "Turn the light on"}
        onPress={onToggleTorch}
        active={torchOn}
      />
    </View>
  );
}

export function CameraBottomBar({
  onCapture,
  onPickFromGallery,
  onFinish,
  capturing,
  capturedCount,
  canCapture,
}: {
  onCapture: () => void;
  onPickFromGallery: () => void;
  onFinish: () => void;
  /** True between the shutter press and the file landing — see ReceiptCamera. */
  capturing: boolean;
  capturedCount: number;
  /** False at the section ceiling. */
  canCapture: boolean;
}) {
  const t = useTheme();
  const { ACCENT } = t;
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        paddingHorizontal: space.xl,
      }}
    >
      {/*
        Gallery stays reachable from inside the camera, not only from the
        screen behind it. A receipt someone already photographed with their
        own camera app is a completely ordinary case, and making them back out
        of the scanner to use it would be the scanner getting in the way.
      */}
      <Pressable
        onPress={onPickFromGallery}
        accessibilityRole="button"
        accessibilityLabel="Choose a photo from your gallery instead"
        hitSlop={10}
        style={({ pressed }) => ({
          width: 40,
          height: 40,
          borderRadius: radius.md,
          backgroundColor: CONTROL_BG,
          borderWidth: 1,
          borderColor: CONTROL_BORDER,
          alignItems: "center",
          justifyContent: "center",
          opacity: pressed ? 0.7 : 1,
        })}
      >
        <Ionicons name="images-outline" size={19} color={ON_DARK} />
      </Pressable>

      <Pressable
        onPress={onCapture}
        disabled={capturing || !canCapture}
        accessibilityRole="button"
        accessibilityLabel={canCapture ? "Capture this section" : "Section limit reached"}
        accessibilityState={{ disabled: capturing || !canCapture }}
        style={({ pressed }) => ({
          width: 72,
          height: 72,
          borderRadius: radius.full,
          borderWidth: 2.5,
          borderColor: ON_DARK,
          backgroundColor: "rgba(26,32,34,0.42)",
          alignItems: "center",
          justifyContent: "center",
          padding: 5,
          opacity: !canCapture ? 0.45 : pressed ? 0.85 : 1,
        })}
      >
        {capturing ? (
          <ActivityIndicator color={ACCENT.onFill} />
        ) : (
          <View
            style={{
              width: "100%",
              height: "100%",
              borderRadius: radius.full,
              backgroundColor: ACCENT.fill,
            }}
          />
        )}
      </Pressable>

      {/*
        Present from the first captured section, not only once there are
        several: a one-section receipt is the common case and must not have to
        pass through a multi-section interface to be scanned.
      */}
      {capturedCount > 0 ? (
        <Pressable
          onPress={onFinish}
          accessibilityRole="button"
          accessibilityLabel={`Finish with ${capturedCount} ${capturedCount === 1 ? "section" : "sections"}`}
          style={({ pressed }) => ({
            flexDirection: "row",
            alignItems: "center",
            gap: 6,
            backgroundColor: t.brandFill,
            paddingVertical: 10,
            paddingLeft: 12,
            paddingRight: 14,
            borderRadius: radius.full,
            minHeight: TAP,
            opacity: pressed ? 0.85 : 1,
          })}
        >
          <Ionicons name="checkmark" size={16} color={t.onBrandFill} />
          <T style={{ fontFamily: font.sansSemibold, fontSize: typeScale.caption, color: t.onBrandFill }}>Finish</T>
        </Pressable>
      ) : (
        // Holds the shutter centred before there is anything to finish.
        <View style={{ width: 40 }} />
      )}
    </View>
  );
}

function RoundButton({
  icon,
  label,
  onPress,
  active,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
  active?: boolean;
}) {
  const t = useTheme();
  const { ACCENT } = t;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={10}
      style={({ pressed }) => ({
        width: 38,
        height: 38,
        borderRadius: radius.full,
        backgroundColor: active ? "rgba(245,165,36,0.22)" : CONTROL_BG,
        borderWidth: 1,
        borderColor: active ? ACCENT.fill : CONTROL_BORDER,
        alignItems: "center",
        justifyContent: "center",
        opacity: pressed ? 0.7 : 1,
      })}
    >
      <Ionicons name={icon} size={18} color={active ? ACCENT.fill : ON_DARK} />
    </Pressable>
  );
}

/**
 * The "Hide guide" affordance under the instruction.
 *
 * Exists because the ghosted overlap strip covers the top fifth of the
 * viewfinder, and on a short section that is occasionally the fifth with the
 * total in it. Guidance the owner cannot switch off stops being guidance.
 */
export function GuideToggle({ hidden, onToggle }: { hidden: boolean; onToggle: () => void }) {
  return (
    <Pressable
      onPress={onToggle}
      accessibilityRole="button"
      accessibilityLabel={hidden ? "Show the alignment guide" : "Hide the alignment guide"}
      hitSlop={12}
      style={{ alignSelf: "center", paddingVertical: space.xs }}
    >
      <T
        style={{
          fontFamily: font.sansSemibold,
          fontSize: 11.5,
          color: "rgba(255,255,255,0.62)",
          textDecorationLine: "underline",
        }}
      >
        {hidden ? "Show guide" : "Hide guide"}
      </T>
    </Pressable>
  );
}

/** The ceiling notice, shown in place of the instruction once eight are taken. */
export function SectionLimitNotice() {
  const t = useTheme();
  const { ACCENT } = t;
  return (
    <View
      style={{
        alignSelf: "center",
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        backgroundColor: "rgba(26,32,34,0.72)",
        borderRadius: radius.full,
        paddingHorizontal: 14,
        paddingVertical: 7,
      }}
    >
      <Ionicons name="information-circle-outline" size={15} color={ACCENT.fill} />
      <T style={{ fontSize: typeScale.caption, color: ON_DARK }}>
        That is the most sections one receipt can hold. Finish to scan them.
      </T>
    </View>
  );
}
