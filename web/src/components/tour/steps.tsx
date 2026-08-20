import type { ComponentType } from "react";
import {
  IconBell,
  IconCamera,
  IconDashboard,
  IconInsights,
  IconRecords,
  IconSparkle,
  IconUpload,
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
  /** The AppShell holds its Quick-add menu open while this step is active. */
  requiresQuickAdd?: boolean;
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
    title: "Welcome to FinSight!",
    body: "Let's take a quick tour and see how FinSight helps you understand your business finances.",
    mascot: { pose: POSES.greeting },
  },
  {
    id: "business-profile",
    title: "Your business profile",
    body: "View or switch between your business profiles. Each business keeps its own records, categories, and financial insights.",
    target: '[data-tour="business-profile"]',
    placement: "right",
    mascot: { pose: POSES.clipboard },
  },
  {
    id: "dashboard",
    title: "Dashboard overview",
    body: "See your available funds, sales, expenses, recent activity, and important financial changes in one place.",
    target: '[data-tour="dashboard-summary"]',
    placement: "bottom",
    mascot: { pose: POSES.pointing, prop: IconDashboard },
  },
  {
    id: "records",
    title: "Records",
    body: "Record and manage your sales and expenses. You can review, edit, delete, and resolve possible duplicate records here.",
    target: '[data-tour="records"]',
    placement: "right",
    mascot: { pose: POSES.notepad, prop: IconRecords },
  },
  {
    id: "receipt-scanner",
    title: "Receipt scanner",
    body: "Upload or capture a receipt and let FinSight extract important information such as the vendor, date, and amount.",
    target: '[data-tour="scan-receipt"]',
    placement: "left",
    mascot: { pose: POSES.clipboard, prop: IconCamera },
    requiresQuickAdd: true,
  },
  {
    id: "csv-import",
    title: "Import a spreadsheet",
    body: "Already have records in a spreadsheet? Import them in batches and review the information before saving.",
    target: '[data-tour="import-csv"]',
    placement: "left",
    mascot: { pose: POSES.greeting, prop: IconUpload },
    requiresQuickAdd: true,
  },
  {
    id: "insights",
    title: "Analytics & recovery insights",
    body: "Understand your spending patterns, financial performance, and how long it may take your business to recover important expenses.",
    target: '[data-tour="insights"]',
    placement: "right",
    mascot: { pose: POSES.pointing, prop: IconInsights },
  },
  {
    id: "ask-finsight",
    title: "Ask FinSight",
    body: "Ask questions about your finances in plain language and receive explanations based on your business records.",
    target: '[data-tour="ask-finsight"]',
    placement: "top",
    mascot: { pose: POSES.askFin, prop: IconSparkle },
  },
  {
    id: "notifications",
    title: "Notifications",
    body: "FinSight notifies you about possible duplicates, unusual expenses, and records that may need your attention.",
    target: '[data-tour="notifications"]',
    placement: "bottom",
    mascot: { pose: POSES.pointing, prop: IconBell },
  },
  {
    id: "complete",
    title: "You're ready to use FinSight!",
    body: "Start by adding a transaction, scanning a receipt, or importing your existing records.",
    mascot: { pose: POSES.celebrating },
    finalActions: [
      { label: "Finish Tour" },
      { label: "Add a Transaction", to: "/records/expenses/new" },
      { label: "Scan a Receipt", to: "/records/receipts/new" },
    ],
  },
];
