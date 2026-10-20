import type { ReactNode } from "react";
import { BarChart3, Bell, Check, Download, FileSpreadsheet, FileText, MessageSquare, MonitorSmartphone, TrendingUp, type LucideIcon } from "lucide-react";
import { Money } from "../Money";
import { MEASURE, Rise, SectionHead } from "./grid";
import { CashflowPreview, CrossDeviceDashboardPreview, ReceiptPreview } from "./LandingPreviews";

function FeatureCard({ title, body, icon: Icon, wide = false, fullOnTablet = false, children }: {
  title: string;
  body: string;
  icon: LucideIcon;
  wide?: boolean;
  fullOnTablet?: boolean;
  children: ReactNode;
}) {
  return (
    <Rise className={`min-w-0 ${fullOnTablet ? "sm:col-span-6" : "sm:col-span-3"} ${wide ? "lg:col-span-3" : "lg:col-span-2"}`}>
      <article className="flex h-full flex-col overflow-hidden rounded-2xl border border-landing-mint-light/70 bg-landing-surface p-4 sm:p-5">
        <div className="mb-4 flex items-start gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-landing-mint-light/70 bg-landing-mint-pale text-landing-green">
            <Icon className="h-5 w-5" aria-hidden />
          </span>
          <div className="min-w-0 pt-1">
            <h3 className="font-landing-display text-base font-bold leading-snug tracking-[-0.025em] text-landing-charcoal">{title}</h3>
            <p className="mt-1 text-[13px] leading-relaxed text-landing-muted">{body}</p>
          </div>
        </div>
        {children}
      </article>
    </Rise>
  );
}

function FeatureNote({ children }: { children: ReactNode }) {
  return (
    <p className="mt-3 flex min-h-9 items-center justify-center gap-2 rounded-xl border border-landing-mint-light/60 bg-landing-mint-pale/70 px-3 py-2 text-center text-[13px] font-medium text-landing-charcoal">
      {children}
    </p>
  );
}

function RecoveryPreview() {
  return (
    <div className="mt-auto rounded-xl border border-landing-mint-light/60 p-4">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs text-landing-muted">Monthly target</p>
          <p className="mt-1 text-xl font-bold text-landing-charcoal">₱<Money value={100000} bare /></p>
        </div>
        <div>
          <p className="text-xs text-landing-muted">Recorded sales</p>
          <p className="mt-1 text-xl font-bold text-landing-charcoal">₱<Money value={67000} bare /></p>
        </div>
      </div>
      <div aria-hidden className="mt-4 h-3 overflow-hidden rounded bg-landing-mint-pale">
        <div className="h-full w-[67%] rounded bg-landing-green" />
      </div>
      <div className="mt-3 flex flex-wrap justify-between gap-2 text-xs">
        <p className="font-semibold text-landing-charcoal">₱<Money value={33000} bare /> remaining</p>
        <p className="text-landing-muted">67% completed</p>
      </div>
    </div>
  );
}

function AskPreview() {
  return (
    <div className="mt-auto">
      <p className="ml-auto w-fit max-w-[90%] rounded-xl rounded-br-sm border border-landing-mint-light/60 bg-landing-mint-pale px-4 py-3 text-[13px] text-landing-charcoal">
        Which expense category is largest?
      </p>
      <div className="mt-3 flex items-center gap-3">
        <img src="/newmascotlogo.png" alt="" width={44} height={44} loading="lazy" className="h-11 w-11 shrink-0 rounded-full border border-landing-mint-light bg-white object-contain p-1" />
        <p className="max-w-[85%] rounded-xl rounded-bl-sm border border-landing-mint-light/60 bg-landing-cream/60 px-4 py-3 text-[13px] leading-relaxed text-landing-charcoal">
          Supplies account for <strong>₱<Money value={12400} bare /></strong> this month.
        </p>
      </div>
      <p className="mt-3 text-center text-[11px] text-landing-muted">Based on your records</p>
    </div>
  );
}

const EXPORTS = [
  ["sales-oct-2026.csv", "Sales records"],
  ["expenses-oct-2026.csv", "Expense records"],
  ["all-records-2026.csv", "All records"],
];

export function BentoGridFeatures() {
  return (
    <section id="features" aria-labelledby="features-title" className="scroll-mt-20 bg-landing-cream">
      <div className={`${MEASURE} py-14 sm:py-20`}>
        <SectionHead
          eyebrow="Everything your shop needs"
          id="features-title"
          title="Designed for how small business owners actually work"
          lede="From daily records to a clearer view of your business."
        />
        <div className="mt-7 grid grid-cols-1 gap-3 sm:grid-cols-6 lg:gap-4">
          <FeatureCard title="Dynamic recovery meter" body="See how you're doing against your goal." icon={BarChart3} wide>
            <RecoveryPreview />
          </FeatureCard>
          <FeatureCard title="Ask FinSight" body="Get answers from your business records." icon={MessageSquare} wide>
            <AskPreview />
          </FeatureCard>
          <FeatureCard title="Receipt capture" body="Snap a receipt and extract the details." icon={FileText}>
            <div className="landing-hero-demo h-[190px] overflow-hidden rounded-xl [&>.lp-receipt-scene]:h-full [&>.lp-receipt-scene]:w-full">
              <ReceiptPreview compact />
            </div>
            <FeatureNote><Check className="h-4 w-4 text-landing-green" aria-hidden />Review, then save.</FeatureNote>
          </FeatureCard>
          <FeatureCard title="Unusual expense alerts" body="Get notified about higher than usual amounts." icon={Bell}>
            <div className="flex min-h-[190px] flex-1 items-center rounded-xl border border-landing-red/25 bg-landing-red/5 p-4">
              <div className="flex items-start gap-3">
                <TrendingUp className="mt-0.5 h-6 w-6 shrink-0 text-landing-red" aria-hidden />
                <div>
                  <p className="text-sm font-bold text-landing-charcoal">Higher than usual</p>
                  <p className="mt-2 text-[13px] leading-relaxed text-landing-muted">Office supplies<br />₱<Money value={4320} bare /> this month<br />(about 2× the usual amount)</p>
                </div>
              </div>
            </div>
            <FeatureNote>Review the source record</FeatureNote>
          </FeatureCard>
          <FeatureCard title="Sales & expense analytics" body="See your sales and expenses over time." icon={BarChart3} fullOnTablet>
            <div className="landing-hero-demo flex min-h-[190px] flex-1 items-center overflow-hidden rounded-xl bg-white">
              <CashflowPreview />
            </div>
            <FeatureNote>Compare your recorded totals</FeatureNote>
          </FeatureCard>
          <FeatureCard title="Phone + web" body="Use the same records on your phone and computer." icon={MonitorSmartphone} wide>
            <CrossDeviceDashboardPreview />
            <FeatureNote>Keep your records together</FeatureNote>
          </FeatureCard>
          <FeatureCard title="Export your records" body="Download your data whenever you need it." icon={FileText} wide>
            <div className="flex min-h-[220px] flex-1 flex-col justify-center gap-2">
              {EXPORTS.map(([name, label]) => (
                <div key={name} className="flex items-center gap-3 rounded-xl border border-landing-mint-light/60 px-3 py-3">
                  <FileSpreadsheet className="h-8 w-8 shrink-0 text-landing-green" aria-hidden />
                  <div className="min-w-0 flex-1">
                    <p className="break-all text-[13px] font-medium text-landing-charcoal">{name}</p>
                    <p className="mt-1 text-xs text-landing-muted">{label}</p>
                  </div>
                  <Download className="h-4 w-4 shrink-0 text-landing-green" aria-hidden />
                </div>
              ))}
            </div>
            <FeatureNote>Take a copy of your records.</FeatureNote>
          </FeatureCard>
        </div>
      </div>
    </section>
  );
}
