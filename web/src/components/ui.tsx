import type { FormEventHandler, ReactNode } from "react";

/**
 * The shared visual vocabulary, adopted from the approved mockup
 * (`pokpokpok.html`).
 *
 * The mockup expresses these as CSS classes (`.pill.ok`, `.kpi`, `.panel`,
 * `.ai-card`). They are React components here instead, for one reason that
 * matters: several of them have an accessibility obligation that a CSS class
 * cannot enforce. A status pill must never be colour-alone, a decorative glow
 * must be aria-hidden, a currency figure must carry the tabular face. Making
 * them components means a call site cannot forget.
 *
 * Colour note: the mockup's emerald/gold and this app's brand/accent scales
 * are within a hair of each other by design (mockup `--brand:#047857` vs
 * brand-600 `#0d7f72`; mockup `--gold-bright:#f59e0b` vs accent-400
 * `#f5a524`). The scales here are kept because their contrast ratios are
 * measured (see lib/chartPalette.ts) and because the mobile app mirrors them.
 */

// ============================================================
// Pill — a status, always with a written label
// ============================================================
// The dot is decorative; the word is the information. This is the mockup's
// `.pill` with its `::before` dot, made colour-independent.

// Themed triples rather than literal scales — see the tint/tone/edge note in
// tailwind.config.js. `bg-tint-brand text-tone-brand` is correct on a white card
// and unreadable on a dark one; `bg-tint-brand text-tone-brand` is correct on
// both, from the same class.
const PILL_TONES = {
  ok: "bg-tint-brand text-tone-brand ring-edge-brand",
  warn: "bg-tint-accent text-tone-accent ring-edge-accent",
  danger: "bg-tint-danger text-tone-danger ring-edge-danger",
  info: "bg-tint-info text-tone-info ring-edge-info",
  neutral: "bg-tint-neutral text-tone-neutral ring-edge-neutral",
} as const;

export type PillTone = keyof typeof PILL_TONES;

export function Pill({ tone = "neutral", children }: { tone?: PillTone; children: ReactNode }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ${PILL_TONES[tone]}`}
    >
      <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-current opacity-90" />
      {children}
    </span>
  );
}

// ============================================================
// Tag — a record's kind (expense vs sales reference)
// ============================================================

export function Tag({ kind }: { kind: "expense" | "sales" }) {
  return kind === "expense" ? (
    <span className="inline-flex shrink-0 rounded-lg bg-tint-accent px-2 py-0.5 text-[11.5px] font-semibold text-tone-accent ring-1 ring-edge-accent">
      Expense
    </span>
  ) : (
    <span className="inline-flex shrink-0 rounded-lg bg-tint-brand px-2 py-0.5 text-[11.5px] font-semibold text-tone-brand ring-1 ring-edge-brand">
      Sales ref.
    </span>
  );
}

// ============================================================
// Card / Panel — the base surface and its padded, titled form
// ============================================================

/**
 * `as` exists for the one shape a wrapper can't express: a panel that IS a
 * form. Nesting a <form> inside a Card div works, but it puts the padding on
 * the wrong element and leaves the card's own class string to be pasted by
 * hand at the call site — which is the thing this component exists to stop.
 * Deliberately narrow: div or form, nothing else.
 */
export function Card({
  as = "div",
  className = "",
  onSubmit,
  children,
}: {
  as?: "div" | "form";
  className?: string;
  onSubmit?: FormEventHandler<HTMLFormElement>;
  children: ReactNode;
}) {
  const classes = `rounded-2xl border border-paper-200 bg-paper shadow-sm ${className}`;
  if (as === "form") {
    return (
      <form className={classes} onSubmit={onSubmit}>
        {children}
      </form>
    );
  }
  return <div className={classes}>{children}</div>;
}

/**
 * `headingLevel` defaults to 2 because a Panel is normally a top-level section
 * of a page whose only other heading is the PageHead <h1>. It used to render
 * <h3> unconditionally, which meant no page in the app contained an <h2> at
 * all and every screen reader outline skipped a level. Pass 3 for a Panel
 * genuinely nested inside another Panel.
 */
export function Panel({
  eyebrow,
  title,
  action,
  headingLevel = 2,
  className = "",
  bodyClassName = "",
  children,
}: {
  eyebrow?: string;
  title?: ReactNode;
  action?: ReactNode;
  headingLevel?: 2 | 3 | 4;
  className?: string;
  bodyClassName?: string;
  children: ReactNode;
}) {
  const Heading = `h${headingLevel}` as const;
  return (
    <Card className={className}>
      {title || action ? (
        <div className="flex flex-wrap items-start justify-between gap-3 px-5 pt-5">
          <div className="min-w-0">
            {eyebrow ? <div className="eyebrow mb-0.5">{eyebrow}</div> : null}
            {title ? <Heading className="text-base font-semibold text-ink-900">{title}</Heading> : null}
          </div>
          {action ? <div className="shrink-0">{action}</div> : null}
        </div>
      ) : null}
      <div className={`px-5 pb-5 ${title || action ? "pt-4" : "pt-5"} ${bodyClassName}`}>{children}</div>
    </Card>
  );
}

// ============================================================
// KpiCard — label + icon chip, big figure, meta line
// ============================================================
// The mockup's `.kpi`. `tone` colours only the icon chip, never the figure,
// so a wall of KPIs stays readable rather than turning into a colour chart.

const KPI_TONES = {
  brand: "bg-tint-brand text-tone-brand",
  accent: "bg-tint-accent text-tone-accent",
  danger: "bg-tint-danger text-tone-danger",
  info: "bg-tint-info text-tone-info",
} as const;

export function KpiCard({
  label,
  value,
  meta,
  glyph,
  tone = "brand",
  valueClassName = "",
}: {
  label: string;
  value: ReactNode;
  meta?: ReactNode;
  glyph: ReactNode;
  tone?: keyof typeof KPI_TONES;
  valueClassName?: string;
}) {
  return (
    <Card className="p-4">
      <div className="mb-2.5 flex items-start justify-between gap-2">
        <span className="text-xs font-semibold text-ink-500">{label}</span>
        <span
          aria-hidden
          className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-base ${KPI_TONES[tone]}`}
        >
          {glyph}
        </span>
      </div>
      <div className={`font-display text-2xl font-bold tracking-[-0.02em] text-ink-900 ${valueClassName}`}>
        {value}
      </div>
      {meta ? <div className="mt-1.5 text-xs text-ink-500">{meta}</div> : null}
    </Card>
  );
}

// ============================================================
// AiCard — "FinSight is speaking"
// ============================================================
// A distinct dark surface so an AI-written explanation is never mistaken for
// a computed figure. The footer line saying so is not optional decoration —
// it is the honesty requirement the brief puts on every AI surface.

export function AiCard({
  title,
  subtitle,
  footer,
  children,
}: {
  title: string;
  subtitle?: string;
  footer?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="surface-ai relative overflow-hidden rounded-2xl p-5 text-brand-50 shadow-md">
      <span
        aria-hidden
        className="surface-ai-glow pointer-events-none absolute -right-10 -top-12 h-44 w-44 rounded-full"
      />
      <div className="relative">
        <div className="mb-3 flex items-center gap-2.5">
          <span
            aria-hidden
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-white/15 text-sm"
          >
            ✦
          </span>
          <div className="min-w-0">
            <b className="block font-display text-[15px] font-bold text-white">{title}</b>
            {subtitle ? <small className="block text-[11px] text-brand-200">{subtitle}</small> : null}
          </div>
        </div>
        <div className="text-sm leading-relaxed text-brand-50">{children}</div>
        {footer ? <div className="mt-3.5 text-[11.5px] text-brand-200">{footer}</div> : null}
      </div>
    </div>
  );
}

/** Highlights a figure inside AiCard prose. Warm, so it reads off the dark ground. */
export function Kw({ children }: { children: ReactNode }) {
  return <span className="font-semibold text-accent-200">{children}</span>;
}

// ============================================================
// InfoNote / Callout — quiet explanation vs. coloured notice
// ============================================================

export function InfoNote({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-start gap-2.5 rounded-xl border border-paper-200 bg-paper-100 px-3.5 py-2.5 text-xs leading-relaxed text-ink-500">
      <span aria-hidden className="mt-px shrink-0">
        ⓘ
      </span>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

const CALLOUT_TONES = {
  info: { box: "bg-tint-info text-tone-info ring-edge-info", glyph: "ⓘ" },
  warn: { box: "bg-tint-accent text-tone-accent ring-edge-accent", glyph: "⚠" },
  brand: { box: "bg-tint-brand text-tone-brand ring-edge-brand", glyph: "✦" },
} as const;

export function Callout({
  tone = "info",
  children,
}: {
  tone?: keyof typeof CALLOUT_TONES;
  children: ReactNode;
}) {
  const t = CALLOUT_TONES[tone];
  return (
    <div
      className={`flex items-start gap-2.5 rounded-xl px-3.5 py-3 text-[13px] leading-relaxed ring-1 ${t.box}`}
    >
      <span aria-hidden className="mt-px shrink-0">
        {t.glyph}
      </span>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

// ============================================================
// PageHead — eyebrow / title / subtitle, plus actions
// ============================================================

export function PageHead({
  eyebrow,
  title,
  subtitle,
  actions,
}: {
  eyebrow?: string;
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        {eyebrow ? <div className="eyebrow">{eyebrow}</div> : null}
        <h1 className="text-xl font-bold text-ink-900 sm:text-2xl">{title}</h1>
        {subtitle ? <p className="mt-1 max-w-2xl text-sm text-ink-500">{subtitle}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

// ============================================================
// FormPage — the shell every create/edit screen renders into
// ============================================================
// These screens used to be a centred `mx-auto max-w-md` card with the title
// inside it. That made them the only pages in the app whose heading did not
// start at the same left edge as everything else: navigate from Records to
// Add expense and the title jumped to the middle of the screen.
//
// So the title now sits in the ordinary PageHead, on the shared left edge,
// and only the FORM is width-limited beneath it. A form still shouldn't run
// to 1700px — a text input that wide is genuinely harder to use, and the
// measure keeps label/field pairs scannable — but that is a constraint on the
// form, not a reason to move the page's heading.

export function FormPage({
  eyebrow,
  title,
  subtitle,
  actions,
  /** Wider than the default, for forms with side-by-side field pairs. */
  wide = false,
  /**
   * Reference material to sit BESIDE the form rather than above it — a receipt
   * photo, the rows of an imported CSV.
   *
   * WHY THIS EXISTS: the max-w above is a rule about FORMS, and a correct one —
   * a text input 1700px wide is genuinely harder to use. But an origin panel is
   * not an input, and squeezing it through the same constraint produced the
   * worst of both: a 50-row table crammed into 576px, the form itself pushed
   * two screens down below it, and the whole right half of a laptop display
   * empty.
   *
   * Side by side is also the point rather than a space-filling exercise. The
   * task is comparison — "does this amount match the file?" — and a source you
   * have to scroll past to reach the field is a source you cannot compare
   * against. The receipt confirm screen already works this way.
   */
  aside,
  children,
}: {
  eyebrow?: string;
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  wide?: boolean;
  aside?: ReactNode;
  children: ReactNode;
}) {
  /*
   * `wide` is 4xl rather than 3xl because the only screens that ask for it —
   * the two business-profile forms — lay their fields out in PAIRS. The
   * max-width rule above is about how wide a single input should get, and at
   * 4xl a two-column row is still only ~430px a column, comfortably inside it,
   * while 3xl was leaving most of a laptop's width empty beside a form that had
   * to wrap its every hint onto three lines to fit.
   *
   * A form with one field per row keeps the narrower default, which is the
   * measure that reasoning was written for.
   */
  const card = <Card className={`${wide ? "max-w-4xl" : "max-w-xl"} p-6 sm:p-7`}>{children}</Card>;

  return (
    <div>
      <PageHead eyebrow={eyebrow} title={title} subtitle={subtitle} actions={actions} />
      {aside ? (
        /*
         * The form comes FIRST in the DOM, and stays first when this collapses
         * to one column on a narrow screen — it is what the owner opened the
         * page to do. Achieving the same visual order with CSS `order` instead
         * would put the tab order out of step with what is on screen, which is
         * exactly the kind of thing the keyboard-navigation pass fixed.
         *
         * `items-start` so the sticky panel has room to stick against; without
         * it the grid stretches both columns to equal height and there is
         * nothing to scroll past.
         */
        <div className="grid gap-4 xl:grid-cols-[minmax(0,36rem)_minmax(0,1fr)] xl:items-start">
          {card}
          <div className="xl:sticky xl:top-6">{aside}</div>
        </div>
      ) : (
        card
      )}
    </div>
  );
}
