import { Link } from "react-router-dom";
import { ArrowRight, ShieldCheck } from "lucide-react";
import { CTA_PRIMARY, CTA_SECONDARY, MEASURE, Rise } from "./grid";
import { DashboardPreview } from "./DashboardPreview";
import { FinancialTrail } from "./FinancialTrail";

/**
 * The hero: trust label, headline, the two CTAs, and the layered dashboard
 * preview. Text column first in source order, so on mobile the pitch stacks
 * above the mockup, and a screen reader meets the claim before the picture.
 *
 * The dashboard is example markup, not a screenshot — see DashboardPreview.
 */
export function HeroSection() {
  return (
    <section id="home" aria-labelledby="hero-title" className="relative overflow-hidden bg-landing-cream">
      {/* edge decoration only — never behind the headline */}
      <FinancialTrail variant="receipt" className="absolute left-4 top-10 hidden h-32 w-32 opacity-[0.08] xl:block" />
      <FinancialTrail variant="dots" className="absolute -bottom-8 left-1/3 hidden h-40 w-40 opacity-[0.06] lg:block" />
      <FinancialTrail variant="watermark" className="absolute -right-6 bottom-6 hidden h-36 w-36 opacity-[0.05] lg:block" />
      <FinancialTrail variant="peso" className="absolute right-8 top-1/3 hidden h-20 w-20 opacity-[0.08] xl:block" />
      <FinancialTrail variant="peso" className="absolute bottom-24 left-10 hidden h-12 w-12 opacity-[0.06] xl:block" />

      <div className={`${MEASURE} relative grid items-center gap-x-14 gap-y-14 pb-16 pt-12 sm:pt-16 lg:grid-cols-12 lg:pb-24`}>
        <div className="lg:col-span-5">
          <Rise>
            <span className="inline-flex items-center gap-2 rounded-full border border-landing-mint-light bg-landing-mint-pale px-3.5 py-1.5 text-[12px] font-semibold text-landing-green">
              <ShieldCheck className="h-3.5 w-3.5" aria-hidden />
              Built for small business owners
            </span>
          </Rise>

          <Rise delay={70}>
            <h1
              id="hero-title"
              className="mt-5 max-w-[16ch] font-display text-[clamp(2.4rem,5.5vw,3.9rem)] font-extrabold leading-[1.04] tracking-[-0.03em] text-landing-charcoal"
            >
              Know where your money <span className="text-landing-green">actually goes</span>{" "}
              <span className="text-landing-green">before the month ends.</span>
            </h1>
          </Rise>

          <Rise delay={140}>
            <p className="mt-6 max-w-[54ch] text-base leading-relaxed text-landing-muted sm:text-lg">
              Stop relying on end-of-month notebooks. FinSight turns your daily sales and supplier receipts into
              real-time profit clarity — with an assistant that answers your financial questions in plain language.
            </p>
          </Rise>

          <Rise delay={210}>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <Link to="/register" className={CTA_PRIMARY}>
                Start Tracking Free
                <ArrowRight className="h-4 w-4" aria-hidden />
              </Link>
              <Link to="/login" className={CTA_SECONDARY}>
                Log in to Account
              </Link>
            </div>
          </Rise>

          <Rise delay={280}>
            <p className="mt-6 max-w-[46ch] rounded-xl border border-landing-mint-light/70 bg-landing-mint-pale/70 px-4 py-3 text-[13px] leading-relaxed text-landing-muted">
              <span className="font-semibold text-landing-charcoal">No credit card required.</span> Made for sari-sari
              stores, carinderias, food stalls and small retailers.
            </p>
          </Rise>
        </div>

        <div className="lg:col-span-7">
          <Rise delay={200}>
            <DashboardPreview />
          </Rise>
        </div>
      </div>
    </section>
  );
}
