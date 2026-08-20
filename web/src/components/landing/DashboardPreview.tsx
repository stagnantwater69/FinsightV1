import { AlertCircle, ArrowRight, ChevronDown } from "lucide-react";
import { useRevealed } from "./grid";
import { FinancialTrail, MintGlow } from "./FinancialTrail";

/**
 * The hero's layered dashboard mockup.
 *
 * Built from real markup and inline SVG — no raster screenshots, no text
 * baked into images. Every figure is deliberately example data (and the
 * container says so to assistive tech), because the project rule is that
 * nothing on this page may pretend to be a real customer's numbers.
 *
 * Charts draw once on first reveal via the shared `trail-draw` keyframe
 * (900ms — inside the spec's 700–1000ms chart window); reduced-motion users
 * see them already drawn.
 */

const CATEGORIES = [
  { label: "Inventory", pct: 48, color: "#063F35" },
  { label: "Supplies", pct: 22, color: "#0C7A62" },
  { label: "Meals & Pantry", pct: 19, color: "#A9DEC9" },
  { label: "Transport", pct: 8, color: "#F5AD19" },
  { label: "Others", pct: 3, color: "#CDEEE0" },
];

const TRANSACTIONS = [
  { date: "May 31", label: "San Miguel Supplier Invoice #1602", amount: "-₱4,600.00", out: true },
  { date: "May 31", label: "GCash Top-up", amount: "+₱1,200.00", out: false },
  { date: "May 30", label: "Puregold — Supplies", amount: "-₱1,364.00", out: true },
];

function LineChart({ animate, tall = false }: { animate: boolean; tall?: boolean }) {
  const d = tall
    ? "M0 54 L18 48 L36 50 L54 40 L72 44 L90 32 L108 36 L126 24 L144 28 L162 16 L180 10"
    : "M0 30 L20 26 L40 28 L60 20 L80 24 L100 14 L120 18 L140 8";
  const h = tall ? 60 : 36;
  const w = tall ? 180 : 140;
  return (
    <svg aria-hidden viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="h-full w-full">
      <path d={`${d} L${w} ${h} L0 ${h} Z`} fill="#E8F7F0" />
      <path
        d={d}
        fill="none"
        stroke="#0C7A62"
        strokeWidth="2"
        strokeLinecap="round"
        pathLength={1}
        strokeDasharray={1}
        className={animate ? "animate-trail-draw" : undefined}
        style={animate ? undefined : { strokeDashoffset: 0 }}
      />
    </svg>
  );
}

function Donut() {
  // stroke-dasharray arcs on a circumference-100 circle.
  let offset = 25; // start at 12 o'clock
  return (
    <svg aria-hidden viewBox="0 0 42 42" className="h-20 w-20 shrink-0">
      {CATEGORIES.map((c) => {
        const seg = (
          <circle
            key={c.label}
            cx="21"
            cy="21"
            r="15.9155"
            fill="none"
            stroke={c.color}
            strokeWidth="6"
            strokeDasharray={`${c.pct} ${100 - c.pct}`}
            strokeDashoffset={offset}
          />
        );
        offset -= c.pct;
        return seg;
      })}
    </svg>
  );
}

function Tile({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`rounded-xl border border-landing-mint-light/70 bg-white p-3.5 ${className}`}>
      {children}
    </div>
  );
}

function TileLabel({ children }: { children: React.ReactNode }) {
  return <p className="text-[11px] font-semibold text-landing-muted">{children}</p>;
}

export function DashboardPreview() {
  const { ref, revealed } = useRevealed<HTMLDivElement>();

  return (
    <div
      ref={ref}
      role="img"
      aria-label="Illustrative preview of the FinSight dashboard, showing example cash flow, profit, spending categories and transactions"
      className="relative"
    >
      <MintGlow className="-inset-8 opacity-60 sm:-inset-14" />

      {/* trail running behind the dashboard */}
      <FinancialTrail variant="flow" className="absolute -left-10 -top-8 h-28 w-[120%] opacity-[0.35]" />

      <div aria-hidden className="relative">
        {/* the receipt photo peeking out on the left. Generated asset —
            cream ground white-balanced to #FBFAF4 so it melts into the hero. */}
        <img
          src="/landing/receipt.webp"
          alt=""
          width={640}
          height={896}
          loading="eager"
          className="absolute -left-10 top-8 hidden w-36 -rotate-6 rounded-xl shadow-md sm:block"
        />

        {/* main dashboard card */}
        <div className="relative ml-0 rounded-2xl border border-landing-mint-light/70 bg-white p-4 shadow-lg sm:ml-10">
          <div className="flex items-center justify-between gap-3 pb-3">
            <p className="font-display text-[13px] font-bold text-landing-charcoal">FinSight Dashboard</p>
            <span className="flex items-center gap-1 rounded-md border border-landing-mint-light/80 px-2 py-1 text-[10px] font-medium text-landing-muted">
              May 1 – May 31, 2024
              <ChevronDown className="h-3 w-3" />
            </span>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Tile>
              <TileLabel>Cash Flow (This Month)</TileLabel>
              <p className="figure mt-1 text-lg font-bold text-landing-charcoal">₱26,250.00</p>
              <p className="mt-0.5 text-[10px] font-semibold text-landing-green">▲ 39% vs Apr 1 – Apr 30</p>
              <div className="mt-2 flex gap-1.5">
                <div className="figure flex h-14 flex-col justify-between text-right text-[7px] leading-none text-landing-muted">
                  <span>20K</span>
                  <span>15K</span>
                  <span>10K</span>
                  <span>5K</span>
                </div>
                <div className="h-14 flex-1">
                  <LineChart animate={revealed} tall />
                </div>
              </div>
              <div className="mt-1 flex justify-between pl-5 text-[7px] leading-none text-landing-muted">
                <span>May 1</span>
                <span>May 16</span>
                <span>May 31</span>
              </div>
            </Tile>

            <Tile>
              <TileLabel>Monthly Profit</TileLabel>
              <p className="figure mt-1 text-lg font-bold text-landing-charcoal">₱7,314.00</p>
              <p className="mt-0.5 text-[10px] font-semibold text-landing-muted">Margin: 27.9%</p>
              <div className="mt-2 h-14">
                <LineChart animate={revealed} tall />
              </div>
            </Tile>

            <Tile>
              <TileLabel>Top Spending Categories</TileLabel>
              <div className="mt-2 flex items-center gap-3">
                <Donut />
                <ul className="space-y-1">
                  {CATEGORIES.map((c) => (
                    <li key={c.label} className="flex items-center gap-1.5 text-[9px] font-medium text-landing-muted">
                      <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: c.color }} />
                      <span className="min-w-16">{c.label}</span>
                      <span className="figure font-semibold text-landing-charcoal">{c.pct}%</span>
                    </li>
                  ))}
                </ul>
              </div>
            </Tile>

            <Tile>
              <TileLabel>Recent Transactions</TileLabel>
              <ul className="mt-2 space-y-2">
                {TRANSACTIONS.map((t) => (
                  <li key={t.label} className="flex items-baseline justify-between gap-2 text-[10px]">
                    <span className="flex min-w-0 items-baseline gap-1.5">
                      <span className="shrink-0 text-landing-muted">{t.date}</span>
                      <span className="truncate font-medium text-landing-charcoal">{t.label}</span>
                    </span>
                    <span
                      className={`figure shrink-0 font-semibold ${t.out ? "text-landing-charcoal" : "text-landing-green"}`}
                    >
                      {t.amount}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="mt-2 flex items-center gap-1 text-[10px] font-bold text-landing-green">
                View all transactions
                <ArrowRight className="h-2.5 w-2.5" />
              </p>
            </Tile>
          </div>
        </div>

        {/* floating spending alert */}
        <div className="absolute -right-3 top-8 w-44 rounded-xl border border-landing-mint-light bg-white p-3 shadow-md sm:-right-6">
          <p className="flex items-center gap-1.5 text-[11px] font-bold text-landing-charcoal">
            <AlertCircle className="h-3.5 w-3.5 animate-soft-pulse text-landing-red" />
            Spending Alert
          </p>
          <p className="mt-1 text-[10px] leading-snug text-landing-muted">
            Meals &amp; pantry is 10% higher than last month.
          </p>
          <p className="mt-1.5 flex items-center gap-1 text-[10px] font-bold text-landing-green">
            Review now
            <ArrowRight className="h-2.5 w-2.5" />
          </p>
        </div>

        {/* peso coin accent — circle-cropped so its ground blends with the cream */}
        <img
          src="/landing/coins.webp"
          alt=""
          width={512}
          height={512}
          loading="lazy"
          className="absolute -bottom-6 -right-3 h-16 w-16 rounded-full object-cover shadow-md"
        />
      </div>

      <p className="mt-4 text-center text-[11px] text-landing-muted sm:mt-6">Shown with example figures.</p>
    </div>
  );
}
