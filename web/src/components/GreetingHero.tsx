import { useAuth } from "../context/AuthContext";
import { Card } from "./ui";
import { SkeletonLine } from "./Skeleton";
import { dateLine, greetingFor, pickHeadline } from "../lib/homeInsight";
import type { DashboardSummary } from "../lib/types";

/**
 * The two ways Fin's line can read, as themed token triples.
 *
 * These mirror `CALLOUT_TONES` in ui.tsx rather than inventing a second,
 * slightly different warn treatment — an owner who has learned that the amber
 * callout means "act on this" reads this panel the same way. `plain` takes the
 * brand triple for the same reason mobile's does.
 *
 * FIN'S NAME IS BRAND, NOT ACCENT, on the plain variant. The accent scale is
 * reserved for the Recovery Meter and primary CTAs (see tailwind.config.js), so
 * a name badge sitting in it every ordinary day would be claiming an urgency it
 * does not have. On the warn variant the whole panel is already the accent
 * triple, and the name inherits it.
 */
const MESSAGE_TONE = {
  plain: "bg-tint-brand text-tone-brand ring-edge-brand",
  warn: "bg-tint-accent text-tone-accent ring-edge-accent",
} as const;

/** Matches the 96px empty-state mascot box, less the row's own breathing room. */
const MASCOT_BOX = 88;

/**
 * Fin, at rest.
 *
 * Mobile plays the greeting as a 103-frame flipbook (see
 * mobile/src/lib/greetingFrames.ts). Those frames are bundled into the app
 * binary there; on web they would be a download on every dashboard load, for
 * decoration, so this holds the sequence's own rest pose — the frame mobile
 * itself falls back to under reduced motion — and breathes instead.
 *
 * The breath is a named keyframe in tailwind.config.js, which means the global
 * prefers-reduced-motion rule in index.css switches it off with everything
 * else; there is no per-component motion check to keep in sync.
 */
function Fin() {
  return (
    <img
      src="/mascot/greeting.webp"
      alt="Fin, FinSight's mascot"
      width={MASCOT_BOX}
      height={MASCOT_BOX}
      // Eager and high priority: this sits at the top of the dashboard, above
      // the fold, so lazy-loading it only guarantees it arrives late.
      loading="eager"
      fetchPriority="high"
      className="animate-breathe h-[88px] w-[88px] shrink-0 select-none"
      draggable={false}
    />
  );
}

/**
 * The dashboard's opening line: who is reading, what day it is, and the one
 * thing worth saying about the business right now.
 *
 * Ported from mobile's GreetingHero so both clients open the same way. The
 * sentence itself comes from `pickHeadline`, shared verbatim with mobile.
 */
export function GreetingHero({ summary }: { summary: DashboardSummary | null }) {
  const { profile } = useAuth();
  const now = new Date();
  const greeting = greetingFor(now.getHours());
  const firstName = profile?.firstName?.trim();
  const headline = summary ? pickHeadline(summary) : null;
  const tone = MESSAGE_TONE[headline?.tone ?? "plain"];

  return (
    <Card className="mb-6 p-5">
      <p className="text-xs uppercase tracking-[0.06em] text-ink-400">{dateLine(now)}</p>

      {/*
        The NAME is the bold word, not the whole line. "Good evening" is the
        same three words every day at this hour; the name is the only part that
        is about the person reading it, so it carries the weight.
      */}
      <h2 className="mt-0.5 font-display text-xl font-semibold text-ink-900">
        {greeting}
        {firstName ? (
          <>
            , <span className="font-extrabold">{firstName}</span>
          </>
        ) : null}
        !
      </h2>

      {/*
        Fin and its line share a row, with a plain gap rather than the panel
        tucking under the mascot: the art's alpha box is a centred square with
        no transparent margin to slide beneath, so any overlap clips it.
      */}
      <div className="mt-4 flex items-center gap-3">
        <Fin />

        <div className={`min-w-0 flex-1 rounded-2xl px-4 py-3 ring-1 ${tone}`}>
          <p className="text-xs font-semibold">Fin</p>
          {headline ? (
            <p className="mt-0.5 text-[13px] leading-relaxed">{headline.text}</p>
          ) : (
            /*
              The panel keeps its shape while the figures load rather than
              popping into existence a beat after the card — a greeting that
              changes height on arrival reads as a glitch.
            */
            <div className="mt-2 space-y-1.5">
              <SkeletonLine className="h-2 w-[92%]" />
              <SkeletonLine className="h-2 w-[64%]" />
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}
