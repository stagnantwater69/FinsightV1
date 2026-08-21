import { useEffect, useRef, useState, type CSSProperties } from "react";
import { ButtonLink } from "../Button";
import { Money } from "../Money";
import { ArrowRight, Check, Store, Utensils, Croissant } from "lucide-react";
import type { RecoveryTargets } from "../../lib/types";

/**
 * The hero's own palette, and the one place in the app that gets to define
 * colours outside the token scale.
 *
 * The reason is that `ink-*` and `paper-*` are THEME-DRIVEN — they resolve to
 * whatever Classic, Light or Dark has set, and the whole point of this surface
 * is that it is the same deep green in all three. A hero that flipped to a
 * pale card in Light would stop being the hero. So these are literals, scoped
 * to this file, and deliberately not added to tailwind.config.js: nothing else
 * should be reaching for them.
 *
 * MINT, not amber. Note that this breaks the accent rule in
 * tailwind.config.js, which reserves `accent-400` for landing CTAs — see the
 * note on the buttons below.
 */
const HERO = {
  /** Deep green wash. Sits behind the header too — see the backdrop div. */
  surface:
    "radial-gradient(90% 62% at 50% -6%, #1f7a55 0%, #12603f 26%, #0b452f 50%, #072f21 72%, #041f16 90%, #02120d 100%)",
  /**
   * Cool halo bleeding down from above the fold.
   *
   * `ellipse closest-side` rather than the mockup's `circle`. A circle in this
   * 1000×620 box is sized to the farthest CORNER, so it is still faintly
   * tinted where the box ends — which draws a hard horizontal seam across the
   * hero at the bottom edge of the glow. Sizing to the closest side puts the
   * transparent stop exactly on the box edge, so the halo ends by fading out
   * instead of by being cut off. Most visible at narrow widths, where the box
   * is wider than the viewport and the edge runs the full screen.
   */
  glow: "radial-gradient(ellipse closest-side, rgba(155,232,160,0.16) 0%, rgba(94,234,212,0) 100%)",
  /** Settles the bottom edge into the section below instead of cutting. */
  fade: "linear-gradient(180deg, rgba(2,18,13,0) 0%, rgba(2,18,13,0.65) 70%, rgba(2,18,13,0.9) 100%)",
  /**
   * Film grain. Kept as an inline data URI rather than a file so the hero
   * costs no extra request — it is ~300 bytes and gzips to almost nothing,
   * where a network round trip on a 3G connection does not.
   */
  noise:
    "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='120'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.22'/%3E%3C/svg%3E\")",
  mint: "#9be8a0",
  /** Ink for text sitting ON mint. Measures far past 4.5:1. */
  mintInk: "#06231c",
} as const;

interface DemoPreset {
  id: string;
  name: string;
  type: string;
  icon: React.ElementType;
  expenses: number;
  sales: number;
  daysLeft: number;
}

const PRESETS: DemoPreset[] = [
  {
    id: "sari-sari",
    name: "Aling Nena's Store",
    type: "Sari-Sari Store",
    icon: Store,
    expenses: 125000,
    sales: 71000,
    daysLeft: 9,
  },
  {
    id: "bakery",
    name: "Santos Craft Bakery",
    type: "Local Bakery",
    icon: Croissant,
    expenses: 180000,
    sales: 115000,
    daysLeft: 12,
  },
  {
    id: "eatery",
    name: "Tita's Carinderia",
    type: "Food Stall & Catering",
    icon: Utensils,
    expenses: 95000,
    sales: 68000,
    daysLeft: 8,
  },
];

function buildDemoTargets(preset: DemoPreset): RecoveryTargets {
  const operatingDays = 25;
  const remainingOperatingDays = Math.max(1, preset.daysLeft - 2);
  const dailyNeededTarget = preset.expenses / operatingDays;
  const remainingTarget = Math.max(0, preset.expenses - preset.sales);
  const adjustedDailyTarget = remainingTarget / remainingOperatingDays;

  return {
    expectedMonthlyExpenses: preset.expenses,
    operatingDays,
    dailyNeededTarget,
    daysInMonth: 31,
    calendarDaysLeftInMonth: preset.daysLeft,
    remainingOperatingDays,
    remainingOperatingDaysIsApproximated: true,
    todaysTarget: Math.round(adjustedDailyTarget),
    todaysSales: Math.round(adjustedDailyTarget * 0.9),
    todaysGap: Math.round(adjustedDailyTarget * -0.1),
    todaysStatus: "below",
    salesThisMonth: preset.sales,
    remainingTarget,
    adjustedDailyTarget,
    monthCoveragePercent: (preset.sales / preset.expenses) * 100,
    onTrack: adjustedDailyTarget <= dailyNeededTarget + 0.005,
  };
}

/** Each of the three checks below has to be something the product does. */
const PROOF_POINTS = [
  "Real-time insights",
  "Built for sari-sari stores",
  // NOT "expert financial guidance". The footer on this same page says
  // FinSight is "not a substitute for certified accounting advice", and a
  // hero that promises expertise the disclaimer then withdraws is worse than
  // one that promises less. What it does do is answer from your own records.
  "Answers from your own records",
];

/**
 * Entrance choreography, in one table.
 *
 * The cluster is seven pieces and they cannot all land at once — that reads
 * as a single image fading in, which is exactly the "screenshot" look the
 * live demo is here to avoid. Reading order drives the order: the panel (the
 * thing worth looking at) first, its rows next, then the caption, then the
 * KPI cards either side, and the sparkline last. The whole sequence is done
 * inside a second, which is the budget before a stagger stops feeling like
 * arrival and starts feeling like waiting.
 *
 * Collected here rather than sprinkled through the JSX so the timings can be
 * read as a sequence and adjusted relative to each other.
 */
const DELAY = {
  panel: 80,
  row: (i: number) => 220 + i * 55,
  caption: 400,
  leftCard: (i: number) => 260 + i * 60,
  rightCard: (i: number) => 290 + i * 60,
  sparkBar: (i: number) => 460 + i * 55,
} as const;

/**
 * Idle drift, one entry per KPI card.
 *
 * Each card drifts on its OWN clock. Sharing a timeline per column made each
 * pair move as a welded block, which is the opposite of what the effect is
 * for — the point is that the cards look like separate objects at slightly
 * different depths, and two things moving in perfect lockstep read as one
 * thing.
 *
 * SLOW AND WIDE. `amplitude` is measured from the resting position in each
 * direction, so the card covers twice that top to bottom — around 20px over
 * nine to twelve seconds. Anything faster stops reading as buoyancy and
 * starts reading as a nervous tic; anything shorter is not visible at all
 * unless you happen to be staring at one card.
 *
 * The durations are deliberately not multiples of each other, so the four
 * never settle into a shared rhythm.
 *
 * `phase` is NEGATIVE on purpose: a negative animation-delay starts the cycle
 * already part-way through, which spreads the four across the wave without
 * the snap a positive delay would cause (see the animation's note in
 * tailwind.config.js). It also means the drift is already underway during the
 * entrance, which is invisible at this speed — a couple of pixels across the
 * whole arrival.
 *
 * COLLISION BUDGET: two stacked cards can drift into each other by the sum of
 * their amplitudes, at most 19px here. The columns are on `gap-6` (24px), so
 * the closest they ever come is about 5px and they never overlap.
 */
const FLOAT = {
  dailyTarget: { duration: "9s", amplitude: "8px", phase: "0s" },
  salesThisMonth: { duration: "11s", amplitude: "10px", phase: "-2.6s" },
  daysLeft: { duration: "10s", amplitude: "9px", phase: "-5.1s" },
  todayVsTarget: { duration: "12s", amplitude: "10px", phase: "-7.4s" },
} as const;

type FloatSpec = (typeof FLOAT)[keyof typeof FLOAT];

function prefersReducedMotion() {
  return typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Eases a figure from its current value to a new one, for the cards that
 * change when a different store is picked.
 *
 * The demo's whole claim is that these numbers are RECALCULATED, and a value
 * that swaps instantly is indistinguishable from a value that was swapped for
 * a different hardcoded string. Watching PHP 7,714 travel down to PHP 4,500
 * is the difference.
 *
 * Deliberately not folded into `Money`: every other figure in the app is a
 * fact that should be readable the instant it renders, and counting them
 * would make loaded data look like it was still settling.
 */
function useCountUp(value: number, duration = 650) {
  const [display, setDisplay] = useState(value);
  // Tracks what is actually on screen, so a change arriving mid-count starts
  // from where the last one got to rather than snapping back.
  const displayRef = useRef(value);
  useEffect(() => {
    displayRef.current = display;
  });

  useEffect(() => {
    const from = displayRef.current;
    if (from === value) return;
    if (prefersReducedMotion()) {
      setDisplay(value);
      return;
    }
    let raf = 0;
    const start = performance.now();
    function tick(now: number) {
      const t = Math.min((now - start) / duration, 1);
      // Cubic ease-out: quick off the mark, settles onto the final figure.
      setDisplay(from + (value - from) * (1 - Math.pow(1 - t, 3)));
      if (t < 1) raf = requestAnimationFrame(tick);
      else setDisplay(value);
    }
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, duration]);

  return display;
}

/** A figure that eases to its new value. */
function CountUpMoney({ value, bare = false }: { value: number; bare?: boolean }) {
  const shown = useCountUp(value);
  return <Money value={shown} bare={bare} />;
}

/**
 * One of the four KPI cards flanking the panel.
 *
 * Two nested elements because two animations want `transform` and only one
 * can have it per element: the outer drifts forever, the inner rises once on
 * entrance. The tilt is a third transform and sits on the column above, for
 * the same reason.
 */
function FloatCard({
  children,
  delay,
  float,
  className = "",
}: {
  children: React.ReactNode;
  delay: number;
  float: FloatSpec;
  className?: string;
}) {
  return (
    <div
      className="animate-float-y"
      style={
        {
          animationDuration: float.duration,
          animationDelay: float.phase,
          "--float-amp": float.amplitude,
        } as CSSProperties
      }
    >
      <div
        className={`animate-card-rise rounded-2xl bg-white px-[18px] py-4 shadow-[0_24px_50px_rgba(0,0,0,0.35)] ${className}`}
        style={{ animationDelay: `${delay}ms` }}
      >
        {children}
      </div>
    </div>
  );
}

export function HeroSection() {
  const [selectedPresetId, setSelectedPresetId] = useState<string>("sari-sari");
  const currentPreset = PRESETS.find((p) => p.id === selectedPresetId) || PRESETS[0];
  const demoStatus = buildDemoTargets(currentPreset);

  return (
    /*
      `relative` with no z-index of its own, on purpose. The backdrop below is
      pulled ABOVE this section's top edge so the green runs behind the
      transparent header, and it can only do that if nothing here clips or
      isolates it. The header wins the paint order by carrying `z-50` as a
      sibling in the layout root — see PublicLayout's overlay mode.
    */
    <section className="relative isolate text-white">
      {/*
        -top-24 is slack, not a measurement. It only has to exceed the header's
        height so the wash is unbroken behind it; overshooting scrolls
        harmlessly off the top of the document, where pinning it to an exact
        header height would leave a bright seam the day that height changes.
      */}
      <div aria-hidden className="absolute inset-x-0 -top-24 bottom-0 -z-10" style={{ background: HERO.surface }}>
        <div className="absolute inset-0" style={{ backgroundImage: HERO.noise, mixBlendMode: "overlay" }} />
        <div
          className="absolute left-1/2 top-[-260px] h-[620px] w-[1000px] -translate-x-1/2"
          style={{ background: HERO.glow }}
        />
        <div className="absolute inset-x-0 bottom-0 h-32" style={{ background: HERO.fade }} />
      </div>

      {/* Copy column */}
      <div className="mx-auto max-w-[860px] animate-hero-rise px-6 pt-16 text-center lg:pt-[64px]">
        <div className="mb-[26px] inline-flex items-center gap-2.5 rounded-full border border-white/[0.12] bg-white/[0.06] px-4 py-[7px] text-xs font-medium text-white/80 backdrop-blur-[10px]">
          <span
            className="h-[7px] w-[7px] rounded-full"
            style={{ backgroundColor: HERO.mint, boxShadow: `0 0 10px ${HERO.mint}` }}
          />
          AI-Powered Financial Tracking for Local Shops
        </div>

        <h1 className="font-display text-4xl font-bold leading-[1.1] tracking-[-0.03em] text-white sm:text-5xl lg:text-[56px]">
          Know where your money actually goes{" "}
          {/*
            A solid mint, not a gradient. The emphasised phrase wraps, and a
            gradient restarts per line — so the last words landed in the middle
            of the ramp and read as a rendering fault. A single value also
            keeps the contrast knowable.
          */}
          <span style={{ color: HERO.mint }}>before the month ends.</span>
        </h1>

        <p className="mx-auto mt-5 max-w-[600px] text-base leading-[1.65] text-white/60">
          Stop relying on end-of-month notebook guesses. FinSight turns your daily sales and supplier receipts into
          real-time profit clarity — with an AI assistant that answers your financial questions in plain language.
        </p>

        <div className="mt-8 mb-[26px] flex flex-wrap justify-center gap-3">
          {/*
            Both CTAs stay ButtonLink — router links, not the mockup's bare
            <button>s. They are the two navigations that matter on this page,
            and a <button> would lose middle-click, cmd-click, "copy link
            address" and the URL preview on hover.

            The mint fill overrides `variant="primary"`'s amber. The accent
            rule in tailwind.config.js reserves amber for exactly this slot, so
            this is a deliberate exception scoped to the dark hero: amber on
            deep green reads as a warning badge rather than as the way
            forward. Every other primary CTA in the app is untouched.
          */}
          <ButtonLink
            to="/register"
            variant="primary"
            size="lg"
            className="glow-cta rounded-full px-[26px] py-3.5 text-[14.5px] font-bold transition hover:brightness-95"
            style={{ backgroundColor: HERO.mint, color: HERO.mintInk, "--glow-color": HERO.mint } as CSSProperties}
          >
            <span>Start Tracking Free</span>
            <ArrowRight className="h-[15px] w-[15px] stroke-[2.5]" />
          </ButtonLink>

          <ButtonLink
            to="/login"
            variant="secondary"
            size="lg"
            className="glow-cta glow-cta-soft rounded-full border-0 bg-white px-[26px] py-3.5 text-[14.5px] font-semibold transition hover:bg-white/90"
            style={{ color: HERO.mintInk, "--glow-color": "#ffffff" } as CSSProperties}
          >
            <span>Log in to Account</span>
          </ButtonLink>
        </div>

        <ul className="flex flex-wrap justify-center gap-x-[26px] gap-y-2 text-[13px] text-white/50">
          {PROOF_POINTS.map((point) => (
            <li key={point} className="flex items-center gap-[7px]">
              <Check className="h-3.5 w-3.5 shrink-0 stroke-[3]" style={{ color: HERO.mint }} />
              {point}
            </li>
          ))}
        </ul>
      </div>

      {/* Demo cluster */}
      <div className="mx-auto mt-[52px] flex max-w-[1180px] flex-wrap items-start justify-center gap-5 px-8 pb-16">
        {/*
          The flanking stacks are decoration, and `md:` hides them below the
          width where the cluster stops being a cluster and becomes three
          cards stacked vertically — at which point the tilt and the drift
          read as a layout bug rather than as depth.

          The tilt is static and lives here, on the column, because the cards
          inside are already spending `transform` on the drift and the
          entrance — see FloatCard.
        */}
        <div className="mt-3.5 hidden w-[238px] shrink-0 -rotate-3 flex-col gap-6 md:flex">
          <FloatCard delay={DELAY.leftCard(0)} float={FLOAT.dailyTarget}>
            <div className="mb-3 flex items-center gap-2.5">
              <span className="flex h-7 w-7 items-center justify-center rounded-[9px] bg-[#dff7ee]">
                <Store className="h-[15px] w-[15px] stroke-[2.4] text-[#0f9b7a]" />
              </span>
              <span className="text-xs font-semibold text-[#6b7b76]">Daily target</span>
            </div>
            {/* Live figures from the selected preset, not fixed text — the
                mockup's "PHP 7,714 / adjusted from 5,000" is what this
                already computes for the sari-sari store. */}
            <div className="text-[19px] font-extrabold tracking-[-0.01em] text-[#0a2b23]">
              <CountUpMoney value={demoStatus.adjustedDailyTarget} />
            </div>
            <div className="mt-1 text-[11.5px] font-semibold text-[#2f7a4f]">
              adjusted from <CountUpMoney value={demoStatus.dailyNeededTarget} bare />
            </div>
          </FloatCard>
          <FloatCard delay={DELAY.leftCard(1)} float={FLOAT.salesThisMonth} className="!bg-[#0f9b7a]">
            <div className="mb-1.5 text-[11.5px] font-semibold text-white/75">Sales this month</div>
            <div className="text-[22px] font-extrabold tracking-[-0.01em] text-white">
              <CountUpMoney value={demoStatus.salesThisMonth} />
            </div>
          </FloatCard>
        </div>

        {/* The interactive part: the store picker driving the KPI cards. */}
        <div
          className="w-full max-w-[430px] animate-card-rise rounded-[20px] bg-paper p-[22px] shadow-[0_30px_70px_rgba(0,0,0,0.42)] sm:min-w-[380px]"
          style={{ animationDelay: `${DELAY.panel}ms` }}
        >
          <div className="mb-[18px] flex items-center justify-between gap-3">
            <div>
              <div className="text-[10.5px] font-bold tracking-[0.08em] text-ink-400">INTERACTIVE LIVE METER DEMO</div>
              {/* `key` remounts the heading on every switch, so the name
                  arrives with the same small rise the figures ease with
                  instead of being swapped underneath them. */}
              <h2
                key={currentPreset.id}
                className="mt-[3px] animate-fade-up font-display text-base font-bold text-ink-900"
              >
                {currentPreset.name}
              </h2>
            </div>
            <span className="flex shrink-0 items-center gap-1.5 rounded-full bg-emerald-50 px-[11px] py-1.5 text-[11.5px] font-bold text-emerald-700">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
              Live
            </span>
          </div>

          {/*
            The mockup draws these three rows as a static list. They are the
            preset switcher instead — same shape, but each row is the control
            that recalculates the panel heading and the four KPI cards
            flanking it, which is the one interactive thing in the hero and
            the reason the panel is worth showing at all.
          */}
          <div className="flex flex-col gap-3">
            {PRESETS.map((preset, i) => {
              const Icon = preset.icon;
              const targets = buildDemoTargets(preset);
              const isSelected = preset.id === selectedPresetId;
              return (
                <button
                  key={preset.id}
                  type="button"
                  onClick={() => setSelectedPresetId(preset.id)}
                  aria-pressed={isSelected}
                  style={{ animationDelay: `${DELAY.row(i)}ms` }}
                  /*
                    `duration-300` on the row and its parts, so selecting one
                    hands the highlight over rather than cutting to it — the
                    meter below takes 700ms to re-fill and an instant row
                    would finish long before the thing it caused.

                    `active:scale` is the press: these look like list items
                    rather than buttons, and without a reaction under the
                    finger a tap on a slow phone feels like a miss.
                  */
                  className={`group flex animate-row-in items-center justify-between gap-3 rounded-xl border px-3.5 py-3 text-left transition-all duration-300 active:scale-[0.99] ${
                    isSelected
                      ? "border-brand-300 bg-brand-50/70 ring-1 ring-brand-200"
                      : "border-paper-200 hover:-translate-y-px hover:border-brand-200 hover:bg-paper-100 hover:shadow-sm"
                  }`}
                >
                  <span className="flex min-w-0 items-center gap-[11px]">
                    <span
                      className={`flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-full transition-all duration-300 ${
                        isSelected ? "scale-105 bg-brand-600" : "bg-brand-50 group-hover:bg-brand-100"
                      }`}
                    >
                      <Icon
                        className={`h-[15px] w-[15px] stroke-[2.2] transition-colors duration-300 ${
                          isSelected ? "text-white" : "text-brand-700"
                        }`}
                      />
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-[13.5px] font-bold text-ink-900">{preset.type}</span>
                      <span className="block text-[11px] text-ink-500">
                        {targets.onTrack ? "On pace" : "Behind pace"} · {targets.monthCoveragePercent.toFixed(0)}%
                      </span>
                    </span>
                  </span>
                  <span className="shrink-0 text-[13.5px] font-bold text-ink-900">
                    <Money value={preset.sales} />
                  </span>
                </button>
              );
            })}
          </div>

          {/*
            Trimmed when the Recovery Meter came out of this panel, but NOT
            dropped. The rows still carry invented shop names against peso
            figures, and this page has a standing rule that anything that
            looks like somebody's books has to say when it isn't — see the
            note at the top of pages/Landing.tsx.
          */}
          <p
            className="mt-4 animate-row-in border-t border-paper-200 pt-3 text-[11px] text-ink-400"
            style={{ animationDelay: `${DELAY.caption}ms` }}
          >
            Example figures for made-up stores. Pick one to recalculate its targets.
          </p>
        </div>

        <div className="mt-5 hidden w-[230px] shrink-0 rotate-3 flex-col gap-6 md:flex">
          <FloatCard delay={DELAY.rightCard(0)} float={FLOAT.daysLeft}>
            {/*
                The mockup put "Shops tracking — 12,480+" here. There is no such
                number: FinSight has no user count to publish, and inventing one
                is the exact fabrication a statistics strip and three fake
                testimonials were already deleted from this page for. What the
                demo genuinely knows is how much month the example store has
                left, so that is what the card shows.
              */}
              <div className="mb-2.5 flex items-center gap-2.5">
                <span className="flex h-7 w-7 items-center justify-center rounded-[9px] bg-[#e6f7e5]">
                  <Check className="h-[15px] w-[15px] stroke-[2.4] text-[#2f7a4f]" />
                </span>
                <span className="text-xs font-semibold text-[#6b7b76]">Days left in month</span>
              </div>
              {/* A whole number in single digits — swapped with a rise rather
                  than counted, since easing 9 to 8 would just look broken. */}
              <div
                key={currentPreset.id}
                className="animate-fade-up text-[21px] font-extrabold tracking-[-0.01em] text-[#0a2b23]"
              >
                {currentPreset.daysLeft}
              </div>
          </FloatCard>
          <FloatCard delay={DELAY.rightCard(1)} float={FLOAT.todayVsTarget}>
            <div className="mb-2.5 text-[11.5px] font-semibold text-[#6b7b76]">Today vs target</div>
            {/* Illustrative only — no figures attached, so it claims nothing. */}
            <div aria-hidden className="flex h-11 items-end gap-[5px]">
              {[44, 66, 38, 82, 58, 90].map((height, i) => (
                <div
                  key={i}
                  className="flex-1 animate-bar-grow rounded-[3px]"
                  /*
                    `--bar-h` drives the keyframe; the matching `height` is
                    what the bar falls back to, and is what actually applies
                    under reduced motion.
                  */
                  style={
                    {
                      "--bar-h": `${height}%`,
                      height: `${height}%`,
                      animationDelay: `${DELAY.sparkBar(i)}ms`,
                      backgroundColor: height === 90 ? HERO.mint : height === 82 ? "#0f9b7a" : "#dff7ee",
                    } as CSSProperties
                  }
                />
              ))}
            </div>
          </FloatCard>
        </div>
      </div>
    </section>
  );
}
