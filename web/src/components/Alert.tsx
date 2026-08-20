import type { ReactNode } from "react";
import { STATUS_TEXT_COLORS } from "../lib/chartPalette";

/**
 * The alert family — Law of Similarity.
 *
 * FinSight raises three kinds of flag, and before this pass each was styled
 * wherever it happened to appear: amber pills in one place, red pills in
 * another, plain grey text in a third. Nothing tied them together, so an owner
 * had to learn each one separately.
 *
 * They now share one visual grammar: a left severity bar, a circled glyph, a
 * bold label, then plain-language detail. That shared shape is what makes them
 * read as one family ("FinSight is flagging something") while the colour and
 * glyph still separate severity at a glance.
 *
 * Severity is never carried by colour alone — every variant ships a distinct
 * glyph and a written label, so it survives colourblindness and greyscale.
 */
export type AlertKind = "duplicate" | "large-expense" | "needs-review" | "recurring" | "info";

interface KindSpec {
  label: string;
  glyph: string;
  /**
   * The saturated severity colour: the left bar, the glyph disc, and the
   * compact badge's fill. Fixed rather than themed — these are solid shapes
   * carrying white text, which works on any background, and keeping them
   * constant is what makes a flag recognisably the same flag in every theme.
   */
  solid: string;
  /**
   * The wash, hairline and label colour, as a CSS-variable triple. Themed,
   * because a pale wash under dark text has to become a deep wash under light
   * text when the page goes dark — see --sev-* in index.css.
   */
  severity: "critical" | "serious" | "warning" | "info";
}

// Ordered by severity, which is also the order they are listed anywhere the
// three appear together.
const KINDS: Record<AlertKind, KindSpec> = {
  "needs-review": {
    label: "Needs review",
    glyph: "!",
    solid: STATUS_TEXT_COLORS.critical,
    severity: "critical",
  },
  "large-expense": {
    label: "Large expense",
    glyph: "▲",
    solid: STATUS_TEXT_COLORS.serious,
    severity: "serious",
  },
  duplicate: {
    label: "Possible duplicate",
    glyph: "⧉",
    solid: STATUS_TEXT_COLORS.warning,
    severity: "warning",
  },
  /*
    A payment the owner asked FinSight to watch is late, or came in at an
    amount they did not expect. Serious rather than informational: the whole
    reason a schedule exists is that the owner said "tell me if this is
    missed", and answering that with the same grey "For your information"
    treatment a finished CSV import gets is the app forgetting its own promise.
  */
  recurring: {
    label: "Recurring payment",
    glyph: "↻",
    solid: STATUS_TEXT_COLORS.serious,
    severity: "serious",
  },
  info: {
    label: "For your information",
    glyph: "i",
    solid: "#149e8d",
    severity: "info",
  },
};

/** Resolves a severity to its themed wash / hairline / label colours. */
function severityStyle(severity: KindSpec["severity"]) {
  return {
    backgroundColor: `rgb(var(--sev-${severity}-bg))`,
    // The hairline is drawn as a ring via box-shadow so it doesn't take part
    // in layout — matching how `ring-1` behaved before this was themed.
    boxShadow: `inset 0 0 0 1px rgb(var(--sev-${severity}-edge))`,
  };
}

/** Maps a backend Notification.type string onto the family. */
export function alertKindFromType(type: string): AlertKind {
  const t = type.toLowerCase();
  if (t.includes("duplicate")) return "duplicate";
  if (t.includes("large")) return "large-expense";
  if (t.includes("review")) return "needs-review";
  // NOTIFICATION_TYPES.RECURRING_SCHEDULE — "Recurring Schedule".
  if (t.includes("recurring")) return "recurring";
  return "info";
}

/** The full-width form, for lists of alerts. */
export function Alert({
  kind,
  children,
  label,
  meta,
  action,
}: {
  kind: AlertKind;
  children: ReactNode;
  /** Overrides the family's default label where a caller has better wording. */
  label?: string;
  meta?: ReactNode;
  action?: ReactNode;
}) {
  const spec = KINDS[kind];
  return (
    <div className="flex gap-0 overflow-hidden rounded-xl" style={severityStyle(spec.severity)}>
      <div aria-hidden className="w-1 shrink-0" style={{ backgroundColor: spec.solid }} />
      <div className="flex flex-1 flex-wrap items-start gap-x-3 gap-y-2 p-3">
        <span
          aria-hidden
          className="mt-px flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-bold text-white"
          style={{ backgroundColor: spec.solid }}
        >
          {spec.glyph}
        </span>
        <div className="min-w-0 flex-1">
          <p
            className="text-xs font-semibold uppercase tracking-wide"
            style={{ color: `rgb(var(--sev-${spec.severity}-ink))` }}
          >
            {label ?? spec.label}
          </p>
          <p className="mt-0.5 break-words text-sm text-ink-700">{children}</p>
          {meta ? <p className="mt-1 text-xs text-ink-400">{meta}</p> : null}
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
    </div>
  );
}

