import { useState } from "react";
import { ArrowRight, Check, MessageSquare, ScanLine } from "lucide-react";
import { Card, MEASURE, Rise, SectionHead } from "./grid";
import { CurveDivider, MintGlow } from "./FinancialTrail";

/**
 * "Show, don't tell" — a tabbed switch between the two mockups that carry
 * the most weight in the pitch: the receipt scanner and the AI assistant.
 * Both panels are aria-hidden example markup with a caption saying so, same
 * rule as the rest of this page (see Landing.tsx).
 */

const TABS = [
  { id: "ocr", label: "Instant Receipt OCR", icon: ScanLine },
  { id: "ai", label: "Natural Language AI", icon: MessageSquare },
] as const;
type TabId = (typeof TABS)[number]["id"];

function OcrPanel() {
  return (
    <div className="grid gap-10 lg:grid-cols-2 lg:items-center">
      <div>
        <p className="flex items-center gap-2 font-landing-sans text-[11px] font-bold uppercase tracking-[0.15em] text-landing-muted">
          Optical Character Recognition
        </p>
        <h3 className="mt-3 max-w-[20ch] font-landing-display text-2xl font-extrabold tracking-[-0.015em] text-landing-charcoal sm:text-[2rem]">
          Turn physical paper receipts into digital records in seconds
        </h3>
        <p className="mt-4 font-landing-sans text-[15px] leading-relaxed text-landing-muted">
          Snap a photo of your supplier invoice or store receipt with your phone camera. FinSight extracts the
          total, date, merchant name, and item categories automatically.
        </p>
        <ul className="mt-5 flex flex-col gap-3">
          {[
            "Reads handwritten and thermal printed receipts",
            "Suggests a category for you to confirm",
            "Flags uncertain values for a one-tap fix",
            "Original photos stay in private storage — links expire in 10 minutes",
          ].map((item) => (
            <li key={item} className="flex items-start gap-3 font-landing-sans text-[15px] text-landing-charcoal/90">
              <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-landing-mint-pale">
                <Check className="h-3 w-3 text-landing-green" strokeWidth={3} />
              </span>
              {item}
            </li>
          ))}
        </ul>
      </div>

      <Card className="p-5 sm:p-6" hover>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-landing-mint-light/70 pb-4">
          <div className="flex items-center gap-3">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-landing-mint-pale">
              <ScanLine className="h-4 w-4 text-landing-green" aria-hidden />
            </span>
            <div>
              <p className="font-landing-display text-[15px] font-bold text-landing-charcoal">Receipt Scanner Demo</p>
              <p className="font-landing-sans text-[13px] text-landing-muted">San Miguel Supplier Invoice #8402</p>
            </div>
          </div>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-landing-mint-light bg-landing-mint-pale px-3 py-1 font-landing-sans text-xs font-semibold text-landing-green">
            <Check className="h-3 w-3" strokeWidth={3} />
            Check before saving
          </span>
        </div>

        <div className="mt-4 flex flex-col gap-2.5">
          {[
            { label: "Beverage Stock (24 Cases)", cat: "Inventory Purchase", amount: "4,800.00" },
            { label: "Cooking Oil & Staples", cat: "Grocery Supplies", amount: "1,450.00" },
          ].map((row) => (
            <div
              key={row.label}
              className="flex flex-wrap items-baseline justify-between gap-2 rounded-xl border border-landing-mint-light/70 bg-landing-surface px-4 py-3"
            >
              <div>
                <p className="font-landing-sans text-sm font-bold text-landing-charcoal">{row.label}</p>
                <p className="mt-0.5 font-landing-sans text-xs text-landing-muted">Category: {row.cat}</p>
              </div>
              <p className="figure text-[15px] font-semibold text-landing-charcoal">₱{row.amount}</p>
            </div>
          ))}
        </div>

        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-landing-emerald px-5 py-4">
          <div>
            <p className="font-landing-sans text-[11px] font-bold uppercase tracking-[0.14em] text-landing-mint/80">
              Total extracted
            </p>
            <p className="figure mt-1 text-2xl font-semibold text-white">₱6,250.00</p>
          </div>
          <span className={"inline-flex items-center gap-2 rounded-full bg-landing-gold px-5 py-2.5 font-landing-sans text-sm font-bold text-landing-charcoal"}>
            Confirm Record
            <ArrowRight className="h-3.5 w-3.5" aria-hidden />
          </span>
        </div>
      </Card>
    </div>
  );
}

function AiPanel() {
  const exchanges = [
    { q: "What was my best selling day this month?", a: "Saturday, July 12 — ₱18,400 in sales." },
    { q: "And which supplier costs me most?", a: "San Miguel — ₱26,900 this month, 31% of supplier spend." },
    { q: "Kaya pa ba ang ₱125,000 goal?", a: "Yes — 67% covered with 9 days left. Keep ₱5,100/day." },
  ];
  return (
    <div className="grid gap-10 lg:grid-cols-2 lg:items-center">
      <div>
        <p className="flex items-center gap-2 font-landing-sans text-[11px] font-bold uppercase tracking-[0.15em] text-landing-muted">
          Assistant
        </p>
        <h3 className="mt-3 max-w-[20ch] font-landing-display text-2xl font-extrabold tracking-[-0.015em] text-landing-charcoal sm:text-[2rem]">
          Natural Language AI Assistant
        </h3>
        <p className="mt-4 font-landing-sans text-[15px] leading-relaxed text-landing-muted">
          Ask in Tagalog or English, the way you would ask a business partner. Answers come only from your own
          recorded sales and expenses — never from another owner's data.
        </p>
        <p className="mt-4 font-landing-sans text-[15px] leading-relaxed text-landing-muted">
          Ask questions like "Why were expenses higher this week?" and get answers generated solely from your
          records.
        </p>
      </div>

      <Card className="p-5 sm:p-6" hover>
        <div className="flex flex-col gap-3">
          {exchanges.map((ex) => (
            <div key={ex.q} className="flex flex-col gap-2">
              <p className="ml-auto max-w-[88%] rounded-2xl rounded-tr-md bg-landing-emerald px-4 py-2.5 font-landing-sans text-sm font-medium text-white">
                {ex.q}
              </p>
              <p className="max-w-[88%] rounded-2xl rounded-tl-md border border-landing-mint-light/70 bg-landing-surface px-4 py-2.5 font-landing-sans text-sm text-landing-charcoal/90">
                {ex.a}
              </p>
            </div>
          ))}
        </div>
        <div className="mt-4 flex items-center gap-2.5 rounded-full border border-landing-mint-light bg-landing-surface py-1.5 pl-4 pr-1.5">
          <span className="flex-1 font-landing-sans text-sm text-landing-muted">Ask in Tagalog or English…</span>
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-landing-green">
            <ArrowRight className="h-3.5 w-3.5 text-white" aria-hidden />
          </span>
        </div>
        <p className="mt-3 font-landing-sans text-xs text-landing-muted">
          Answers use only your own recorded sales and expenses.
        </p>
      </Card>
    </div>
  );
}

export function ProductShowcase() {
  const [tab, setTab] = useState<TabId>("ocr");

  return (
    <section
      aria-labelledby="showcase-title"
      className="landing-section-gradient-mint relative overflow-hidden bg-landing-mint-pale"
    >
      {/* the trust strip's white arcs down into this mint band */}
      <CurveDivider from="surface" className="relative z-10" />
      <MintGlow className="inset-x-8 inset-y-0 opacity-40" />

      <div className={`${MEASURE} relative py-16 sm:py-24`}>
        <div className="mx-auto max-w-[46rem] text-center">
          <SectionHead
            eyebrow="Show, don't tell"
            id="showcase-title"
            title="See how FinSight handles your daily financial records"
            lede="No complex accounting terms. Snap receipt photos or ask questions in plain language — your assistant does the rest."
          />
          <p className="mt-2 font-landing-sans text-[13px] text-landing-muted">
            Illustrations of the actual screens, using sample figures for an example store.
          </p>

          <Rise delay={100}>
            <div
              role="tablist"
              aria-label="Product demonstrations"
              className="mx-auto mt-7 inline-flex max-w-full flex-wrap justify-center gap-1 rounded-2xl border border-landing-mint-light bg-landing-surface p-1.5 shadow-sm sm:rounded-full"
            >
              {TABS.map((t) => {
                const Icon = t.icon;
                const selected = tab === t.id;
                return (
                  <button
                    key={t.id}
                    type="button"
                    role="tab"
                    id={`tab-${t.id}`}
                    aria-selected={selected}
                    aria-controls={`panel-${t.id}`}
                    onClick={() => setTab(t.id)}
                    className={`inline-flex min-h-tap items-center justify-center gap-1.5 rounded-full px-3.5 font-landing-sans text-[13px] font-bold transition duration-150 ease-shell sm:gap-2 sm:px-5 sm:text-sm ${
                      selected
                        ? "bg-landing-charcoal text-landing-surface"
                        : "text-landing-muted hover:text-landing-charcoal"
                    }`}
                  >
                    <Icon className="h-4 w-4 shrink-0" aria-hidden />
                    {t.label}
                  </button>
                );
              })}
            </div>
          </Rise>
        </div>

        <div
          role="tabpanel"
          id={`panel-${tab}`}
          aria-labelledby={`tab-${tab}`}
          className="mt-10 animate-fade-up rounded-[28px] border border-landing-mint-light/70 bg-landing-surface p-6 shadow-md sm:p-10"
        >
          {tab === "ocr" ? <OcrPanel /> : <AiPanel />}
        </div>
      </div>
    </section>
  );
}
