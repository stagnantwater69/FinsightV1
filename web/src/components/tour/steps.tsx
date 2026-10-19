import type { ComponentType } from "react";
import {
  IconDashboard,
  IconInsights,
  IconPlus,
  IconRecords,
  IconSparkle,
} from "../icons";

/**
 * The product tour, as data.
 *
 * One entry per step: what to highlight, what Fin says, and which Fin appears.
 * The overlay component walks this list; nothing else in the app knows the
 * steps exist, so adding/removing/reordering a step is an edit to this file
 * alone.
 *
 * MASCOT MAPPING. Only seven Fin illustrations exist today (see
 * docs/mascot-scenario-library.md for the full wishlist vs.
 * web/public/mascot/ for reality). Rather than generating new art — which
 * cannot be done without risking the character's identity — each step maps
 * to the CLOSEST EXISTING POSE plus an optional "prop badge": a small themed
 * chip carrying one of the app's own icons, composited beside the mascot at
 * render time by TourMascot. That keeps every variation pixel-identical to
 * the approved character, crisp at any DPI, theme-aware, and adds zero
 * image downloads. When a dedicated pose is illustrated later (e.g. Fin
 * scanning a receipt), point `pose` at the new file here and drop the badge.
 *
 * TARGETS are `data-tour` attributes, never CSS classes — markup can be
 * restyled freely without breaking the tour. A selector may match several
 * elements (sidebar + bottom-nav render the same destination); the overlay
 * picks whichever is visible at the current viewport size.
 */

export type TourIcon = ComponentType<{ className?: string }>;

export interface TourStep {
  id: string;
  title: string;
  body: string;
  /** `data-tour` selector. Omitted → centered card (welcome / completion). */
  target?: string;
  /** Preferred tooltip side on desktop; the overlay flips it if space runs out. */
  placement?: "top" | "bottom" | "left" | "right";
  mascot: {
    /** Base pose asset. TourMascot falls back to POSE_FALLBACK if it 404s. */
    pose: string;
    /** Prop badge composited onto the pose — the situation-specific part. */
    prop?: TourIcon;
  };
  /** Completion card renders these instead of Back/Next. */
  finalActions?: { label: string; to?: string }[];
}

/** Used when a pose asset fails to load — the one Fin every screen already has. */
export const POSE_FALLBACK = "/mascot/greeting.webp";

const POSES = {
  greeting: "/mascot/greeting.webp",
  clipboard: "/mascot/01-onboarding/businessprofilesetup.webp",
  pointing: "/mascot/01-onboarding/tutorial.webp",
  notepad: "/mascot/01-onboarding/emptydashboard.webp",
  askFin: "/mascot/ask-fin.webp",
  celebrating: "/mascot/01-onboarding/onboardingcomplete.webp",
} as const;

export const TOUR_STEPS: TourStep[] = [
  {
    id: "welcome",
    title: "Welcome to FinSight",
    body: "A short look at where to record your sales and expenses, and where to read what they add up to. You can leave at any point.",
    mascot: { pose: POSES.greeting },
  },
  {
    id: "business-profile",
    title: "Your business",
    body: "Everything you record belongs to the business shown here. Running more than one? Switch here. Each business keeps its own records and categories.",
    target: '[data-tour="business-profile"]',
    placement: "right",
    mascot: { pose: POSES.clipboard },
  },
  {
    id: "dashboard",
    title: "Your dashboard",
    body: "Once you have recorded some sales and expenses, this shows your available funds, how the month is going, and what changed. It stays mostly empty until then.",
    target: '[data-tour="dashboard-summary"]',
    placement: "bottom",
    mascot: { pose: POSES.pointing, prop: IconDashboard },
  },
  {
    id: "quick-add",
    title: "Quick add",
    body: "Add a sale or an expense, scan a receipt photo, or import records from a CSV file. It is on every page.",
    target: '[data-tour="quick-add"]',
    placement: "bottom",
    mascot: { pose: POSES.clipboard, prop: IconPlus },
  },
  {
    id: "records",
    title: "Records",
    body: "Every sale and expense ends up here. Edit or delete entries, and check the ones FinSight flags as possible duplicates.",
    target: '[data-tour="records"]',
    placement: "right",
    mascot: { pose: POSES.notepad, prop: IconRecords },
  },
  {
    id: "insights",
    title: "Insights",
    body: "See where your money goes by category, catch unusual expenses, and track how far this month's sales are toward covering your expected costs.",
    target: '[data-tour="insights"]',
    placement: "right",
    mascot: { pose: POSES.pointing, prop: IconInsights },
  },
  {
    id: "ask-finsight",
    title: "Ask FinSight",
    body: "Ask about your numbers in your own words, like \"What did I spend the most on this month?\" Answers come from your own records.",
    target: '[data-tour="ask-finsight"]',
    placement: "top",
    mascot: { pose: POSES.askFin, prop: IconSparkle },
  },
  {
    id: "complete",
    title: "That's the tour",
    body: "Start with something you have on hand, like today's sales or the receipt from a recent purchase.",
    mascot: { pose: POSES.celebrating },
    // Three, so they fit one row on a phone. A scanned receipt becomes an
    // expense, and Quick add covers expenses without one.
    finalActions: [
      { label: "Add a sale", to: "/records/sales/new" },
      { label: "Scan a receipt", to: "/records/receipts/new" },
      { label: "Done" },
    ],
  },
];
