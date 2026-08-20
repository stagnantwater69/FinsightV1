import { BadgeCheck, Lock, MonitorSmartphone, Timer, type LucideIcon } from "lucide-react";
import { MEASURE, Rise } from "./grid";
import { CurveDivider } from "./FinancialTrail";

/**
 * The trust strip under the hero — the reference design's big-figure tiles.
 *
 * THE DESIGN MOCKUP SHOWED USAGE COUNTS ("20,000+ small businesses", "5M+
 * receipts processed"). Those numbers do not exist anywhere in this project,
 * and this page's standing rule (see Landing.tsx) is that every claim must
 * survive "where did that come from" — an earlier stats strip was deleted
 * for exactly this. So the strip keeps the mockup's icon + big figure +
 * caption layout, but every figure below is true today. When real usage
 * metrics exist, swap them into ITEMS — the layout is already theirs.
 */
const ITEMS: { icon: LucideIcon; figure: string; mono?: boolean; caption: string }[] = [
  {
    icon: BadgeCheck,
    figure: "₱0",
    mono: true,
    caption: "to get started — no credit card required",
  },
  {
    icon: Timer,
    figure: "Seconds",
    caption: "from receipt photo to a checked digital record",
  },
  {
    icon: MonitorSmartphone,
    figure: "Phone + Web",
    caption: "same records, always in sync",
  },
  {
    icon: Lock,
    figure: "Private",
    caption: "your data is yours — ownership checked on every request",
  },
];

export function TrustMetrics() {
  return (
    <section aria-label="Why owners trust FinSight" className="bg-white">
      {/* the hero's cream arcs down into this white band */}
      <CurveDivider from="#FBFAF4" />
      <div className={`${MEASURE} grid grid-cols-1 gap-x-0 gap-y-7 py-8 sm:grid-cols-2 lg:grid-cols-4 lg:py-10`}>
        {ITEMS.map((item, i) => {
          const Icon = item.icon;
          return (
            <Rise key={item.figure} delay={i * 60} className={i > 0 ? "lg:border-l lg:border-landing-mint-light/70 lg:pl-8" : ""}>
              <div className="flex items-center gap-4">
                <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-landing-mint-pale ring-1 ring-landing-mint-light">
                  <Icon className="h-5 w-5 text-landing-green" aria-hidden />
                </span>
                <div>
                  <p
                    className={`font-display text-2xl font-extrabold tracking-[-0.02em] text-landing-charcoal ${
                      item.mono ? "figure" : ""
                    }`}
                  >
                    {item.figure}
                  </p>
                  <p className="mt-1 max-w-[26ch] text-[13px] font-medium leading-snug text-landing-muted">
                    {item.caption}
                  </p>
                </div>
              </div>
            </Rise>
          );
        })}
      </div>
    </section>
  );
}
