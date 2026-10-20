import { BadgeCheck, Lock, MonitorSmartphone, ReceiptText } from "lucide-react";
import { MEASURE } from "./grid";
import { CurveDivider } from "./FinancialTrail";

const ITEMS = [
  { icon: BadgeCheck, title: "₱0 to start", caption: "No credit card required" },
  { icon: ReceiptText, title: "Review first", caption: "Confirm scanned details" },
  { icon: MonitorSmartphone, title: "Phone + Web", caption: "One view of your business" },
  { icon: Lock, title: "Your records", caption: "Scoped to your business" },
];

export function TrustMetrics() {
  return (
    <section aria-label="Getting started with FinSight" className="landing-section-gradient-raised bg-landing-surface">
      <CurveDivider from="hero" />
      <div className={`${MEASURE} grid grid-cols-1 gap-x-6 gap-y-6 pb-8 pt-4 min-[420px]:grid-cols-2 lg:grid-cols-4 lg:gap-x-7 lg:pb-9 lg:pt-5`}>
        {ITEMS.map(({ icon: Icon, title, caption }, index) => (
          <div key={title} className={`flex items-center gap-3 ${index ? "lg:border-l lg:border-landing-mint-light/70 lg:pl-7" : ""}`}>
            <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full border border-landing-mint-light bg-landing-mint-pale"><Icon className="h-5 w-5 text-landing-green" aria-hidden /></span>
            <div><p className="font-landing-display text-[17px] font-extrabold tracking-[-0.035em] text-landing-charcoal sm:text-lg">{title}</p><p className="mt-1 font-landing-sans text-xs leading-relaxed text-landing-muted sm:text-[13px]">{caption}</p></div>
          </div>
        ))}
      </div>
    </section>
  );
}
