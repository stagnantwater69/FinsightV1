import { useState } from "react";
import { ArrowRight, Camera, MessageSquare } from "lucide-react";
import { Money } from "../Money";
import { MEASURE } from "./grid";
import { CurveDivider } from "./FinancialTrail";
import { ReceiptPreview, ReceiptReviewPreview } from "./LandingPreviews";
import { useHorizontalTabKeys } from "../../lib/hooks";

const TABS = [
  { id: "ocr", label: "Receipt scanning", icon: Camera },
  { id: "ai", label: "Ask FinSight", icon: MessageSquare },
] as const;
type TabId = (typeof TABS)[number]["id"];

function OcrPanel() {
  return (
    <div className="lp-showcase-workflow">
      <div className="lp-showcase-copy">
        <h3 className="max-w-[19ch] font-landing-display text-2xl font-extrabold leading-[1.15] tracking-[-0.04em] text-landing-charcoal lg:text-[26px]">Turn paper receipts into checked records</h3>
        <p className="mt-3 max-w-[40ch] font-landing-sans text-sm leading-relaxed text-landing-muted">Snap a photo, review the extracted details, and save a clean record connected to your sales and expenses.</p>
      </div>
      <img className="lp-showcase-photo" src="/landing/receipt-capture.webp" width="1122" height="1402" alt="Illustration of a shop owner photographing a receipt with a phone" loading="lazy" decoding="async" />
      <ArrowRight className="lp-showcase-arrow" aria-hidden />
      <ReceiptPreview />
      <ArrowRight className="lp-showcase-arrow" aria-hidden />
      <ReceiptReviewPreview />
      <p className="lp-showcase-caption text-center font-landing-sans text-xs leading-relaxed text-landing-muted">Check extracted details before saving.</p>
    </div>
  );
}

function AiPanel() {
  return (
    <div className="grid gap-8 py-2 lg:grid-cols-[.8fr_1.2fr] lg:items-center lg:gap-16">
      <div>
        <h3 className="max-w-[22ch] font-landing-display text-2xl font-extrabold leading-[1.15] tracking-[-0.04em] text-landing-charcoal sm:text-[30px]">Ask a question. Find it in your records.</h3>
        <p className="mt-4 max-w-[42ch] font-landing-sans text-[15px] leading-relaxed text-landing-muted">Ask about sales, expenses, or spending patterns in plain language. FinSight uses your active business's records to help explain the numbers.</p>
      </div>
      <figure className="m-0">
        <div className="flex flex-col gap-4 rounded-2xl border border-landing-mint-light/70 bg-landing-cream/40 p-5 sm:p-7">
          <p className="ml-auto max-w-[88%] rounded-xl rounded-tr-sm bg-landing-mint-pale px-4 py-3 font-landing-sans text-sm text-landing-charcoal">Which expense category is largest?</p>
          <div className="flex items-start gap-3">
            <img src="/newmascotlogo.png" width="44" height="44" className="h-11 w-11 shrink-0 rounded-full bg-white p-1 object-contain" alt="" />
            <div className="max-w-[88%] rounded-xl rounded-tl-sm border border-landing-mint-light/70 bg-landing-surface px-4 py-3 font-landing-sans text-sm leading-relaxed text-landing-charcoal">
              <p>Supplies account for <strong>₱<Money value={12400} bare /></strong> this month, your largest recorded expense category.</p>
              <p className="mt-3 border-t border-landing-mint-light/70 pt-3 text-xs text-landing-muted">Based on this business's October expense records.</p>
            </div>
          </div>
        </div>
      </figure>
    </div>
  );
}

export function ProductShowcase() {
  const [tab, setTab] = useState<TabId>("ocr");
  const onTabKeys = useHorizontalTabKeys();

  return (
    <section aria-labelledby="showcase-title" className="landing-section-gradient-mint relative overflow-hidden bg-landing-mint-pale">
      <CurveDivider from="raised" />
      <div className={`${MEASURE} pb-14 pt-7 sm:pb-16 sm:pt-8`}>
        <div className="mx-auto max-w-[46rem] text-center">
          <p className="font-landing-sans text-[11px] font-bold uppercase tracking-[0.14em] text-landing-green">Show, don't tell</p>
          <h2 id="showcase-title" className="mx-auto mt-3 max-w-[30ch] font-landing-display text-[clamp(1.7rem,3.3vw,2.35rem)] font-extrabold leading-[1.14] tracking-[-0.04em] text-landing-charcoal">See how FinSight handles your daily financial records</h2>
          <p className="mt-3 font-landing-sans text-[15px] leading-relaxed text-landing-muted sm:text-base">Capture a receipt. Check the details. Save a record you can use.</p>
          <div role="tablist" aria-label="Product demonstrations" aria-orientation="horizontal" onKeyDown={onTabKeys} className="mx-auto mt-5 inline-flex max-w-full flex-wrap justify-center gap-1 rounded-full border border-landing-mint-light/70 bg-landing-surface p-1 shadow-sm">
            {TABS.map(({ id, label, icon: Icon }) => (
              <button key={id} type="button" role="tab" id={`product-showcase-tab-${id}`} aria-selected={tab === id} aria-controls="product-showcase-panel" tabIndex={tab === id ? 0 : -1} onClick={() => setTab(id)} className={`inline-flex min-h-tap items-center justify-center gap-2 rounded-full px-4 font-landing-sans text-[13px] font-semibold transition-colors sm:px-6 sm:text-sm ${tab === id ? "bg-landing-emerald text-white" : "text-landing-muted hover:bg-landing-mint-pale hover:text-landing-charcoal"}`}>
                <Icon className="h-4 w-4 shrink-0" aria-hidden />{label}
              </button>
            ))}
          </div>
        </div>
        <div role="tabpanel" id="product-showcase-panel" aria-labelledby={`product-showcase-tab-${tab}`} tabIndex={0} className="mt-5 rounded-[20px] border border-landing-mint-light/70 bg-landing-surface p-5 shadow-sm sm:p-7 lg:p-8">
          {tab === "ocr" ? <OcrPanel /> : <AiPanel />}
        </div>
      </div>
    </section>
  );
}
