import { useEffect, useState } from "react";
import { Image, View, type ImageSourcePropType, type StyleProp, type ViewStyle } from "react-native";

import { useTheme } from "../context/ThemeContext";
import { radius } from "../theme/tokens";

/**
 * Fin, as a small state language.
 *
 * ===================================================================
 * WHY A MAPPER AND NOT `require(...)` AT THE CALL SITE
 * ===================================================================
 * There are twenty-odd mascot poses in `assets/mascot/`, their filenames are
 * inconsistent (`singupstart.png`, `passwordresetsuccesss.png`, one with a
 * literal space in it), and Metro resolves `require` at build time from a
 * string literal — so a typo is a red screen on the device and nothing at all
 * in typecheck. Screens naming a SEMANTIC STATE instead means:
 *
 *   - the filenames are wrong in exactly one place, and a test can read that
 *     place and check every path against the filesystem (tests/mascotAssets);
 *   - a state can be re-pointed at better art without touching a screen;
 *   - "which Fin is on this screen" is answerable by reading one table rather
 *     than grepping for `require`.
 *
 * ===================================================================
 * THE STATE LIST IS THE APPROVED SET, NOT THE WHOLE FOLDER
 * ===================================================================
 * `docs/MOBILE-UI-UX-IMPROVEMENT-PLAN.md` §2 approves a compact first-use set
 * and explicitly rules out "a random mascot pose as decoration". Poses that
 * exist on disk but are not in that set — `successfullogin`, `failedlogin`,
 * `session expired`, `Accountlocked`, `datasyncing`, `aigeneratinginsights`,
 * `longrunningprocess`, `datamismatchfound`, `tutorial` — are deliberately
 * absent. Adding one is a product decision, not a wiring change.
 *
 * The tour keeps its own table in `tour/TourMascot.tsx`: it composites a prop
 * badge over the pose and needs a pose *vocabulary* (greeting, pointing,
 * clipboard) rather than a moment. Merging the two would make one of them
 * lie about what its keys mean.
 *
 * ===================================================================
 * RULES THIS COMPONENT ENFORCES SO SCREENS CANNOT GET THEM WRONG
 * ===================================================================
 * DECORATIVE BY DEFAULT. Every appearance is `accessible={false}` and hidden
 * from assistive technology. The plan's rule is that the written message must
 * be fully understandable without the image, so announcing the image would
 * only add a second, vaguer copy of the heading a screen reader is about to
 * read anyway — and it would insert itself *before* that heading, which is
 * the one ordering the plan asks to preserve. `label` exists for the rare
 * case where the illustration is the only thing carrying the state; passing
 * it is an explicit decision to make it announceable.
 *
 * `resizeMode="contain"`, always. These are square exports with the character
 * floating in transparent padding; `cover` crops ears, wings and props.
 *
 * STATIC. No animation here at all. The plan allows a loop only for genuine
 * ongoing work and a one-shot only for a completed milestone, and both of
 * those need Reduce Motion handling that belongs to the screen that owns the
 * work — not to a picture.
 *
 * ONE PER VIEWPORT is a rule this component cannot enforce; it is a review
 * item. See the plan's placement rules.
 *
 * ===================================================================
 * MEMORY
 * ===================================================================
 * The sources are LAZY THUNKS, not eagerly-evaluated `require`s in an object
 * literal. Metro's `require` of an image is cheap on its own (it returns an
 * asset descriptor, not a decoded bitmap), but a module-level table of two
 * dozen of them makes it very easy for a future change — a preload, a
 * prefetch loop, a `Object.values(...).map(Image.prefetch)` — to pull the
 * whole collection into memory on a low-end Android device at once. Deferring
 * the call to render time means only the poses actually shown ever resolve.
 *
 * The source art is ~1–2 MB per PNG at 1024². That is fine for one image on
 * screen and NOT fine for several; compressing mobile copies is still open
 * work, flagged in the plan. Nothing here loads more than one at a time.
 */

/**
 * THE ART IS NOT CUT OUT, and this is the workaround.
 *
 * Every pose in `assets/mascot/` except `finsightlogo.png` is an OPAQUE RGB
 * PNG on a near-white plate (measured: 252–255 on all three channels at all
 * four corners of all 33 files), at a variety of aspect ratios rather than
 * square. The manifest in that folder asks for "transparent background"; the
 * delivered art does not have one.
 *
 * On a white card in Light mode nobody can tell. In Dark mode the same image
 * is a bright white rectangle sitting on a near-black card — and with
 * `resizeMode="contain"` inside a square box, a portrait-shaped pose also
 * letterboxes, so the rectangle is not even the shape of the picture.
 *
 * Until cut-out art exists, the illustration is drawn on a deliberate rounded
 * plate of the SAME near-white the art already carries. That turns an
 * accident into a framed sticker: no seam, because the plate and the art's
 * own background are the same colour, and it reads as intentional in both
 * themes. It is invisible in Light, where the card behind it is already white.
 *
 * REPLACING THE ART IS THE REAL FIX. When transparent poses land, pass
 * `plate={false}` (or flip the default) and this whole treatment disappears.
 *
 * The colour is `mascotPlate` in theme/palette.ts — fixed in both themes,
 * because it is a property of the artwork rather than of the page.
 */

/** The approved moments. One key per product moment, not per file. */
export type MascotState =
  // 01-onboarding
  | "signUpStart"
  | "businessSetup"
  | "onboardingComplete"
  | "emptyDashboard"
  | "cameraPermission"
  // 02-authentication
  | "login"
  | "forgotPassword"
  | "passwordResetSuccess"
  | "logoutConfirmation"
  // 03-loading-processing
  | "appLaunch"
  | "receiptScanning"
  | "uploadingFile"
  | "aiAnalyzing"
  // 04-empty-states
  | "noTransactions"
  | "noExpenseRecords"
  | "noSalesRecords"
  | "noNotifications"
  | "noSearchResults"
  | "offline"
  // 06-warnings
  | "importErrors"
  | "lowAvailableFunds"
  | "budgetAlmostExceeded"
  | "possibleDuplicate"
  | "unusualExpense"
  // The mark itself, for brand moments that are not a character moment.
  | "brandMark";

type Thunk = () => ImageSourcePropType;

/**
 * The one table.
 *
 * Kept as `state: () => require("…")` on a single line each, because
 * tests/mascotAssets.test.ts parses this shape: plain node cannot execute a
 * PNG `require`, so the test reads the literal paths out of this file and
 * checks them against the filesystem. Reformatting a row across two lines is
 * fine; changing the `require("…")` spelling is not.
 */
const SOURCES: Record<MascotState, Thunk> = {
  signUpStart: () => require("../../assets/mascot/01-onboarding/singupstart.png"),
  businessSetup: () => require("../../assets/mascot/01-onboarding/businessprofilesetup.png"),
  onboardingComplete: () => require("../../assets/mascot/01-onboarding/onboardingcomplete.png"),
  emptyDashboard: () => require("../../assets/mascot/01-onboarding/emptydashboard.png"),
  cameraPermission: () => require("../../assets/mascot/01-onboarding/permission.png"),

  login: () => require("../../assets/mascot/02-authentication/loginscreed(idle).png"),
  forgotPassword: () => require("../../assets/mascot/02-authentication/forgotpassword.png"),
  passwordResetSuccess: () => require("../../assets/mascot/02-authentication/passwordresetsuccesss.png"),
  logoutConfirmation: () => require("../../assets/mascot/02-authentication/logout confirmation.png"),

  appLaunch: () => require("../../assets/mascot/03-loading-processing/pageappfirstload(splash).png"),
  receiptScanning: () => require("../../assets/mascot/03-loading-processing/ocrreceiptscanning.png"),
  uploadingFile: () => require("../../assets/mascot/03-loading-processing/uploadingfiles.png"),
  aiAnalyzing: () => require("../../assets/mascot/03-loading-processing/aianalyzingdata.png"),

  noTransactions: () => require("../../assets/mascot/04-empty-states/notransactionyet.png"),
  noExpenseRecords: () => require("../../assets/mascot/04-empty-states/noexpenserecords.png"),
  noSalesRecords: () => require("../../assets/mascot/04-empty-states/nosalesrecords.png"),
  noNotifications: () => require("../../assets/mascot/04-empty-states/nonotifications.png"),
  noSearchResults: () => require("../../assets/mascot/04-empty-states/nosearchresults.png"),
  offline: () => require("../../assets/mascot/04-empty-states/nointernetconnection.png"),

  importErrors: () => require("../../assets/mascot/06-warnings/importerrorsfound.png"),
  lowAvailableFunds: () => require("../../assets/mascot/06-warnings/lowavailablefunds.png"),
  budgetAlmostExceeded: () => require("../../assets/mascot/06-warnings/budgetalmostexceeded.png"),
  possibleDuplicate: () => require("../../assets/mascot/06-warnings/possibleduplicatefound.png"),
  unusualExpense: () => require("../../assets/mascot/06-warnings/unusualexpensedetected.png"),

  brandMark: () => require("../../assets/mascot/finsightlogo.png"),
};

/**
 * What is shown when the requested state's art will not load.
 *
 * The badge mark, not another character pose: it is the smallest, most
 * compressible asset here, it is already a native resource on this device
 * (it is the app icon's source), and it carries no expression — so falling
 * back to it can never put a cheerful Fin beside a failure, which is the one
 * thing the plan's severity rule forbids outright.
 */
const FALLBACK: Thunk = SOURCES.brandMark;

/**
 * Resolve a state to art, without throwing.
 *
 * A `MascotState` that does not exist is a typecheck failure, so the guard is
 * for the untyped edges — a state name arriving from data, a key that a
 * refactor dropped from the table. Never `undefined`: `<Image source={undefined}>`
 * is a silently empty box on the device and a warning nobody reads.
 */
export function mascotSource(state: MascotState): ImageSourcePropType {
  const thunk = SOURCES[state] ?? FALLBACK;
  try {
    return thunk();
  } catch {
    return FALLBACK();
  }
}

export function Mascot({
  state,
  size = 96,
  style,
  label,
  plate = true,
}: {
  state: MascotState;
  /** Rendered square. The art is `contain`ed inside it, never cropped. */
  size?: number;
  style?: StyleProp<ViewStyle>;
  /**
   * Draw the rounded near-white plate behind the art. On by default because
   * none of the current poses are cut out — see the plate note above. Pass `false`
   * for genuinely transparent art, or where the surface behind is already
   * that colour.
   */
  plate?: boolean;
  /**
   * Only when the illustration is the sole carrier of the state — which,
   * per the plan, it should never be. Omitting it (the default) hides the
   * image from assistive technology so the heading below stays first.
   */
  label?: string;
}) {
  const t = useTheme();
  const [source, setSource] = useState<ImageSourcePropType>(() => mascotSource(state));
  const [gaveUp, setGaveUp] = useState(false);

  // The component is reused across states (a wizard step advancing, an auth
  // screen switching to its success state), so the fallback chain has to be
  // re-armed rather than left latched on the previous failure.
  useEffect(() => {
    setSource(mascotSource(state));
    setGaveUp(false);
  }, [state]);

  // Second failure: the fallback itself would not load. Render nothing at all
  // rather than a broken-image box — the text says everything already.
  if (gaveUp) return null;

  const decorative = label === undefined;

  return (
    <View
      style={[
        {
          width: size,
          height: size,
          alignSelf: "center",
          ...(plate
            ? { backgroundColor: t.mascotPlate, borderRadius: radius.lg, overflow: "hidden" as const }
            : null),
        },
        style,
      ]}
      accessible={!decorative}
      accessibilityRole={decorative ? undefined : "image"}
      accessibilityLabel={label}
      importantForAccessibility={decorative ? "no-hide-descendants" : "yes"}
      accessibilityElementsHidden={decorative}
    >
      <Image
        source={source}
        style={{ width: "100%", height: "100%" }}
        resizeMode="contain"
        accessibilityIgnoresInvertColors
        onError={() => {
          const fallback = FALLBACK();
          // Comparing identity, not equality: Metro's asset descriptors are
          // interned per path, so "the fallback is what already failed" is a
          // reference check and not a deep compare of an opaque value.
          if (source === fallback) setGaveUp(true);
          else setSource(fallback);
        }}
      />
    </View>
  );
}
