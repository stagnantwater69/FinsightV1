import { ArrowRight, Check, Plus } from "lucide-react";
import { Card, MEASURE, Rise, SectionHead } from "./grid";
import { CurveDivider, FinancialTrail, MintGlow } from "./FinancialTrail";

/**
 * The receipt workflow: snap → AI extracts → digitized & categorized.
 *
 * Three visual stages with directional connectors, each stage a mockup card
 * (aria-hidden example data) above a real caption. On mobile the stages
 * stack and the connectors rotate to vertical.
 */

const STAGES = [
  {
    n: 1,
    title: "Snap any receipt",
    body: "Use your phone to capture paper receipts.",
  },
  {
    n: 2,
    title: "AI extracts in seconds",
    body: "FinSight reads the details and shows them to you to check.",
  },
  {
    n: 3,
    title: "Digitized & categorized",
    body: "The record is saved and categorized — after you confirm it.",
  },
];

/** The connector between stages: horizontal on desktop, vertical stacked. */
function Connector() {
  return (
    <div aria-hidden className="flex items-center justify-center py-2 md:py-0">
      <span className="flex h-8 w-8 items-center justify-center rounded-full bg-landing-green text-white shadow-sm">
        <ArrowRight className="h-4 w-4 rotate-90 md:rotate-0" />
      </span>
    </div>
  );
}

/** Stage 1 — a receipt inside OCR scanning corners. */
function SnapVisual() {
  return (
    <div className="relative mx-auto w-36 py-3">
      {/* scanning corners */}
      <svg aria-hidden viewBox="0 0 144 176" className="absolute inset-0 h-full w-full">
        <path d="M4 28 v-24 h24" fill="none" stroke="#0C7A62" strokeWidth="4" strokeLinecap="round" />
        <path d="M140 28 v-24 h-24" fill="none" stroke="#0C7A62" strokeWidth="4" strokeLinecap="round" />
        <path d="M4 148 v24 h24" fill="none" stroke="#0C7A62" strokeWidth="4" strokeLinecap="round" />
        <path d="M140 148 v24 h-24" fill="none" stroke="#0C7A62" strokeWidth="4" strokeLinecap="round" />
      </svg>
      <img
        src="/landing/receipt.webp"
        alt=""
        width={640}
        height={896}
        loading="lazy"
        className="mx-auto w-28 rounded-md object-cover shadow-sm"
      />
    </div>
  );
}

/** Stage 2 — the extraction card. */
function ExtractVisual() {
  return (
    <div className="mx-auto w-full max-w-[13rem] py-3">
      <p className="flex items-center gap-1.5 text-[11px] font-bold text-landing-green">
        <span className="h-1.5 w-1.5 animate-soft-pulse rounded-full bg-landing-green" />
        OCR Extracting…
      </p>
      <div className="mt-2 rounded-lg border border-landing-mint-light bg-landing-mint-pale/60 p-3">
        <p className="text-[12px] font-semibold text-landing-charcoal">San Miguel Supplier</p>
        <p className="text-[11px] text-landing-muted">Invoice #1602</p>
        <p className="figure mt-2 text-base font-bold text-landing-charcoal">₱4,600.00</p>
        <div className="mt-2 flex items-center justify-between">
          <span className="figure text-[11px] font-semibold text-landing-green">97%</span>
          <span className="flex h-5 w-5 items-center justify-center rounded-full bg-landing-green text-white">
            <Plus className="h-3 w-3" />
          </span>
        </div>
      </div>
    </div>
  );
}

/** Stage 3 — the completed emerald transaction card. */
function RecordedVisual() {
  return (
    <div className="mx-auto w-full max-w-[13rem] py-3">
      <div className="rounded-lg bg-landing-emerald p-3.5 shadow-md">
        <p className="flex items-center gap-1.5 text-[11px] font-bold text-landing-mint-light">
          <span className="flex h-4 w-4 items-center justify-center rounded-full bg-landing-mint text-landing-emerald">
            <Check className="h-2.5 w-2.5" strokeWidth={3} />
          </span>
          Expense Recorded
        </p>
        <p className="mt-2.5 text-[12px] font-semibold text-white">San Miguel Supplier</p>
        <p className="text-[11px] text-landing-mint-light/80">Invoice #1602</p>
        <div className="mt-2 flex items-baseline justify-between">
          <span className="text-[10px] text-landing-mint-light/80">May 31, 2024 · Inventory</span>
        </div>
        <p className="figure mt-1 text-base font-bold text-white">₱4,600.00</p>
      </div>
    </div>
  );
}

const VISUALS = [SnapVisual, ExtractVisual, RecordedVisual];

export function ProductShowcase() {
  return (
    <section aria-labelledby="showcase-title" className="relative overflow-hidden bg-landing-mint-pale">
      {/* the trust strip's white arcs down into this mint band */}
      <CurveDivider from="#FFFFFF" className="relative z-10" />
      <FinancialTrail variant="grid" className="absolute inset-x-0 top-0 h-32 w-full opacity-[0.06]" />

      <div className={`${MEASURE} relative py-16 sm:py-24`}>
        <div className="grid gap-x-12 gap-y-10 lg:grid-cols-12">
          <div className="lg:col-span-4">
            <SectionHead
              eyebrow="See it in action"
              id="showcase-title"
              title="See how FinSight handles your daily financial records"
              lede="No complex accounting terms. Snap receipt photos or ask questions in plain language — your assistant does the rest."
            />
          </div>

          <div className="relative lg:col-span-8">
            <MintGlow className="inset-x-8 inset-y-0 opacity-50" />
            <div className="relative grid items-center md:grid-cols-[1fr_auto_1fr_auto_1fr] md:gap-2">
              {STAGES.map((stage, i) => {
                const Visual = VISUALS[i]!;
                return (
                  <div key={stage.n} className="contents">
                    {i > 0 ? <Connector /> : null}
                    <Rise delay={i * 120}>
                      <div className="flex h-full flex-col">
                        <Card className="flex-1 p-4">
                          <div aria-hidden>
                            <Visual />
                          </div>
                        </Card>
                        <div className="px-1 pt-4">
                          <h3 className="font-display text-[15px] font-bold text-landing-charcoal">
                            {stage.n}. {stage.title}
                          </h3>
                          <p className="mt-1 text-[13px] leading-relaxed text-landing-muted">{stage.body}</p>
                        </div>
                      </div>
                    </Rise>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
