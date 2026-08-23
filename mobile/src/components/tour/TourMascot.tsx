import { useEffect, useState } from "react";
import { Image, View, type ImageSourcePropType } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useTheme } from "../../context/ThemeContext";
import type { TourPose, TourStep } from "./steps";

/**
 * Fin, as the tour guide.
 *
 * Renders the step's base pose with an optional prop badge — a small themed
 * chip carrying one of the app's own icons — pinned to the pose's lower
 * corner. The badge is what makes a pose situation-specific (Fin "with" a
 * bell, a camera, a spreadsheet) without generating new character art; see the
 * mapping note in steps.ts.
 *
 * THE POSE TABLE LIVES HERE, not in steps.ts, because `require` of a PNG is a
 * Metro thing that plain node cannot do, and steps.ts is imported by the test
 * runner. Keeping the table beside the renderer also means the fallback and
 * the mapping cannot drift apart.
 *
 * Only four onboarding poses exist on the phone plus the greeting Fin every
 * screen already has, so two of web's mappings are approximated:
 *   - `askFin`: web has a dedicated ask-fin illustration. Mobile's nearest is
 *     assets/FAB.png, whose art sits off-centre in its canvas and is sized by
 *     lib/artCrop at every call site — dropping it into a square box would
 *     render Fin small and off to one side. The greeting pose plus a sparkles
 *     badge is the honest substitute until a real pose is drawn.
 *   - `notepad`/`clipboard`/`pointing` map to the onboarding poses, exactly as
 *     web maps them.
 *
 * FAILURE HANDLING, in order: a pose that will not load swaps to the greeting
 * pose; if even that fails the image is dropped and the card carries on. The
 * tour must never show a broken-image box or stall over an asset.
 *
 * DECORATIVE. The step text carries every piece of information, so the image
 * is `accessible={false}` and hidden from assistive tech — the same rule the
 * rest of the app's mascots follow.
 */

const GREETING = require("../../../assets/greeting.png") as ImageSourcePropType;

const POSE_SOURCES: Record<TourPose, ImageSourcePropType> = {
  greeting: GREETING,
  clipboard: require("../../../assets/mascot/01-onboarding/businessprofilesetup.png") as ImageSourcePropType,
  pointing: require("../../../assets/mascot/01-onboarding/tutorial.png") as ImageSourcePropType,
  notepad: require("../../../assets/mascot/01-onboarding/emptydashboard.png") as ImageSourcePropType,
  askFin: GREETING,
  celebrating: require("../../../assets/mascot/01-onboarding/onboardingcomplete.png") as ImageSourcePropType,
};

/** Used when a pose asset will not load — the Fin every screen already has. */
export const POSE_FALLBACK: ImageSourcePropType = GREETING;

export function TourMascot({ mascot, size = 72 }: { mascot: TourStep["mascot"]; size?: number }) {
  const t = useTheme();
  const { brand, paper } = t;
  const [source, setSource] = useState<ImageSourcePropType>(POSE_SOURCES[mascot.pose]);
  const [failed, setFailed] = useState(false);

  // A new step reuses this mounted component — reset the fallback chain.
  useEffect(() => {
    setSource(POSE_SOURCES[mascot.pose]);
    setFailed(false);
  }, [mascot.pose]);

  if (failed) return null;

  const badge = Math.round(size * 0.34);

  return (
    <View
      accessible={false}
      importantForAccessibility="no-hide-descendants"
      style={{ width: size, height: size }}
    >
      <Image
        source={source}
        resizeMode="contain"
        accessibilityIgnoresInvertColors
        onError={() => {
          if (source !== POSE_FALLBACK) setSource(POSE_FALLBACK);
          else setFailed(true);
        }}
        style={{ width: "100%", height: "100%" }}
      />
      {mascot.prop ? (
        <View
          style={{
            position: "absolute",
            right: -2,
            bottom: -2,
            width: badge,
            height: badge,
            borderRadius: badge / 2,
            backgroundColor: brand[100],
            // A ring in the card's own colour, so the badge reads as sitting
            // on top of Fin rather than punched out of him.
            borderWidth: 2,
            borderColor: paper.DEFAULT,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Ionicons name={mascot.prop} size={Math.round(badge * 0.55)} color={brand[700]} />
        </View>
      ) : null}
    </View>
  );
}
