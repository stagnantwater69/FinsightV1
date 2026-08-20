import type { Ionicons } from "@expo/vector-icons";

/**
 * The product tour, as data.
 *
 * One entry per step: what to highlight, what Fin says, and which Fin appears.
 * TourOverlay walks this list; nothing else in the app knows the steps exist,
 * so adding, removing or reordering one is an edit to this file alone.
 *
 * WEB'S TEN STEPS, in web's order, saying the same things (tests/webParity
 * pins both) — PLUS TWO the phone adds. Every one of web's ten features exists
 * here — checked against the screens, not assumed — so none was dropped. What
 * changed is WHERE each step points, because the two apps put the same feature
 * in different places:
 *
 *   - business-profile: web points at its sidebar profile block; the phone has
 *     the business switcher in Home's header.
 *   - records / insights: web points at sidebar links, the phone at the tab
 *     bar items that reach the same screens.
 *   - receipt-scanner / csv-import: web opens its Quick-add menu and points at
 *     the item inside it. The phone does the same — `requiresQuickAdd` holds
 *     the raised "+" menu open (App.tsx watches `activeStepId`) and the step
 *     spotlights the Scan receipt and Import CSV circles in the arc.
 *
 *     These two used to point at the "+" button itself and at Home's Import
 *     CSV tile. Both were wrong in the same way: the tour said "upload or
 *     capture a receipt" while highlighting a button that does neither on its
 *     own, and taught importing through a shortcut that exists on one screen
 *     rather than through the control that is on every screen. Pointing INSIDE
 *     the open menu shows the owner the two taps they will actually make.
 * THE TWO MOBILE-ONLY STEPS, and why they are not drift. The "+" menu holds
 * five actions and the tour was opening it to talk about two of them, leaving
 * the owner looking at an arc of five circles with three unexplained — on the
 * app's most prominent control. Web's Quick-add menu is one item in a sidebar
 * an owner can read at leisure; a phone's is a ring of unlabelled circles that
 * appears and disappears. So the phone teaches the two that record money by
 * hand — an expense and a sales reference — which are also the only way in for
 * an owner with no receipt and no spreadsheet. Categories is left out: it is a
 * setup task rather than a daily one, and onboarding already creates the first
 * categories. Recorded as a deliberate divergence in tests/webParity.test.ts,
 * the same way the always-show preference is.
 *
 *   - complete: web offers deep links ("Add a Transaction", "Scan a Receipt")
 *     as final actions. The phone finishes onto Home, where the quick actions
 *     the tour has just pointed at are one tap away — so the last card carries
 *     Finish alone rather than three buttons on a phone-width sheet.
 *
 * TARGETS ARE KEYS, not selectors or component references. A screen registers
 * an element with `useTourTarget("dashboard-summary")`; the overlay measures
 * whatever is registered under that key at the time. Markup can be restyled or
 * re-nested freely without breaking the tour, and a key that nothing registers
 * — a feature not on screen, an element that never lays out — makes the step
 * SKIP rather than strand the tour. Same rule web follows.
 *
 * MASCOT MAPPING, unchanged in reasoning from web. Only a handful of Fin
 * illustrations exist (see docs/mascot-scenario-library.md for the wishlist vs
 * mobile/assets/mascot/ for reality). Rather than generating new art — which
 * cannot be done without risking the character's identity — each step maps to
 * the CLOSEST EXISTING POSE plus an optional "prop badge": a small themed chip
 * carrying one of the app's own icons, composited beside the mascot at render
 * time by TourMascot. Every variation stays pixel-identical to the approved
 * character, crisp at any density, and costs no extra asset. When a dedicated
 * pose is drawn later, point `pose` at it here and drop the badge.
 *
 * WHY POSES ARE NAMES AND NOT `require(...)` CALLS: this file is imported by
 * the test runner, which is plain node and cannot load a PNG. The name → asset
 * table lives in TourMascot.tsx, next to the code that renders it. That also
 * keeps the mapping itself assertable.
 */

type IoniconName = keyof typeof Ionicons.glyphMap;

/** Elements a screen can register for the spotlight. */
export type TourTargetKey =
  | "business-switcher"
  | "dashboard-summary"
  | "tab-records"
  /** The raised "+" itself — the probe for the two steps that open its menu. */
  | "quick-add"
  | "quick-add-expense"
  | "quick-add-sales"
  | "quick-add-scan"
  | "quick-add-csv"
  | "tab-insights"
  | "ask-finsight"
  | "notifications";

/** The poses TourMascot knows how to resolve. */
export type TourPose = "greeting" | "clipboard" | "pointing" | "notepad" | "askFin" | "celebrating";

export interface TourStep {
  id: string;
  title: string;
  body: string;
  /** Omitted → a centered card (welcome, completion). */
  target?: TourTargetKey;
  /**
   * Hold the "+" menu open for this step, because its target is one of the
   * actions inside it.
   *
   * Eligibility is then asked of the "+" BUTTON, not of the item: the item
   * only exists while the menu is open, and the menu only opens because this
   * step is the active one — so probing the item would make the step skip
   * itself before it ever got the chance to open the menu. Same reasoning as
   * web's `requiresQuickAdd`.
   */
  requiresQuickAdd?: boolean;
  mascot: {
    pose: TourPose;
    /** Prop badge composited onto the pose — the situation-specific part. */
    prop?: IoniconName;
  };
}

export const TOUR_STEPS: readonly TourStep[] = [
  {
    id: "welcome",
    title: "Welcome to FinSight!",
    body: "Let's take a quick tour and see how FinSight helps you understand your business finances.",
    mascot: { pose: "greeting" },
  },
  {
    id: "business-profile",
    title: "Your business profile",
    body: "View or switch between your business profiles. Each business keeps its own records, categories, and financial insights.",
    target: "business-switcher",
    mascot: { pose: "clipboard" },
  },
  {
    id: "dashboard",
    title: "Dashboard overview",
    body: "See your available funds, sales, expenses, recent activity, and important financial changes in one place.",
    target: "dashboard-summary",
    mascot: { pose: "pointing", prop: "grid-outline" },
  },
  {
    id: "records",
    title: "Records",
    body: "Record and manage your sales and expenses. You can review, edit, delete, and resolve possible duplicate records here.",
    target: "tab-records",
    mascot: { pose: "notepad", prop: "receipt-outline" },
  },
  {
    id: "manual-entry",
    title: "Record an expense by hand",
    body: "No receipt to scan? Enter the date, amount, description, and category yourself.",
    target: "quick-add-expense",
    requiresQuickAdd: true,
    mascot: { pose: "notepad", prop: "wallet-outline" },
  },
  {
    id: "sales-reference",
    title: "Add a sales reference",
    body: "Record a sales figure you want to monitor. It is a note to yourself for tracking, not a receipt issued to a customer.",
    target: "quick-add-sales",
    requiresQuickAdd: true,
    // Not `notepad` again: the step before it uses that pose, and two
    // identical Fins in a row read as a card that failed to change.
    mascot: { pose: "pointing", prop: "cash-outline" },
  },
  {
    id: "receipt-scanner",
    title: "Receipt scanner",
    body: "Upload or capture a receipt and let FinSight extract important information such as the vendor, date, and amount.",
    target: "quick-add-scan",
    requiresQuickAdd: true,
    mascot: { pose: "clipboard", prop: "camera-outline" },
  },
  {
    id: "csv-import",
    title: "Import a spreadsheet",
    body: "Already have records in a spreadsheet? Import them in batches and review the information before saving.",
    target: "quick-add-csv",
    requiresQuickAdd: true,
    mascot: { pose: "greeting", prop: "cloud-upload-outline" },
  },
  {
    id: "insights",
    title: "Analytics & recovery insights",
    body: "Understand your spending patterns, financial performance, and how long it may take your business to recover important expenses.",
    target: "tab-insights",
    mascot: { pose: "pointing", prop: "bar-chart-outline" },
  },
  {
    id: "ask-finsight",
    title: "Ask FinSight",
    body: "Ask questions about your finances in plain language and receive explanations based on your business records.",
    target: "ask-finsight",
    mascot: { pose: "askFin", prop: "sparkles-outline" },
  },
  {
    id: "notifications",
    title: "Notifications",
    body: "FinSight notifies you about possible duplicates, unusual expenses, and records that may need your attention.",
    target: "notifications",
    mascot: { pose: "pointing", prop: "notifications-outline" },
  },
  {
    id: "complete",
    title: "You're ready to use FinSight!",
    body: "Start by adding a transaction, scanning a receipt, or importing your existing records.",
    mascot: { pose: "celebrating" },
  },
];

/**
 * The steps that need the "+" menu held open, for the tab bar to watch.
 *
 * Derived from the list rather than restated there: a third quick-add step
 * would otherwise be added here and silently never open the menu, which on a
 * device looks exactly like a step whose target has gone missing.
 */
export const QUICK_ADD_STEP_IDS: readonly string[] = TOUR_STEPS.filter(
  (step) => step.requiresQuickAdd,
).map((step) => step.id);

/**
 * Which steps can be shown right now.
 *
 * `canShow` answers "is this target on screen and measurable" — the overlay
 * passes the target registry, tests pass whatever case they are pinning. A
 * step with no target is always eligible: those are the centered cards.
 */
export type StepEligibility = (step: TourStep) => boolean;

/**
 * What has to be on screen for a step to be shown — which is not always the
 * thing the step points at. See `requiresQuickAdd`.
 */
export function eligibilityTarget(step: {
  target?: TourTargetKey;
  requiresQuickAdd?: boolean;
}): TourTargetKey | undefined {
  return step.requiresQuickAdd ? "quick-add" : step.target;
}

export function eligibleStepIndexes(
  steps: readonly TourStep[],
  canShow: StepEligibility,
): number[] {
  return steps.reduce<number[]>((acc, step, i) => {
    if (!step.target || canShow(step)) acc.push(i);
    return acc;
  }, []);
}

/**
 * The next step in the direction of travel, skipping anything that cannot be
 * shown — or null, which means "there is nothing further this way".
 *
 * `null` going forward is what the overlay turns into "Finish"; `null` going
 * back is what disables Back on the first eligible step. A step whose target
 * never measures is simply passed over, so a missing element can never leave
 * the tour pointing at nothing with no way onward.
 */
export function nextStepIndex(
  steps: readonly TourStep[],
  from: number,
  canShow: StepEligibility,
): number | null {
  const after = eligibleStepIndexes(steps, canShow).filter((i) => i > from);
  return after.length ? after[0]! : null;
}

export function previousStepIndex(
  steps: readonly TourStep[],
  from: number,
  canShow: StepEligibility,
): number | null {
  const before = eligibleStepIndexes(steps, canShow).filter((i) => i < from);
  return before.length ? before[before.length - 1]! : null;
}

/**
 * "N of M", counting only what this owner will actually be shown.
 *
 * Counting all ten while showing eight would leave visible gaps in the
 * numbering — "3 of 10" followed by "5 of 10" — which reads as a tour that has
 * lost its place. Same rule as web.
 */
export function stepPosition(
  steps: readonly TourStep[],
  index: number,
  canShow: StepEligibility,
): { position: number; total: number } {
  const eligible = eligibleStepIndexes(steps, canShow);
  const at = eligible.indexOf(index);
  return {
    position: at >= 0 ? at + 1 : Math.min(index + 1, steps.length),
    total: eligible.length || steps.length,
  };
}
