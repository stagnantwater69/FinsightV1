import { ButtonLink } from "../Button";
import { Sparkles, CheckCircle2, ShieldCheck, ArrowRight } from "lucide-react";

export function ClosingCta() {
  return (
    <section className="mx-auto max-w-6xl px-4 py-16 lg:px-6 lg:py-24">
      <div className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-brand-950 via-brand-900 to-brand-950 p-8 text-center text-white shadow-2xl sm:p-14 lg:p-16 border border-brand-800">
        {/* Ambient Decorative Lighting */}
        <div
          aria-hidden
          className="pointer-events-none absolute -left-20 -top-20 h-72 w-72 rounded-full bg-brand-500/20 blur-3xl"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute -bottom-20 -right-20 h-72 w-72 rounded-full bg-accent-400/15 blur-3xl"
        />

        <div className="relative z-10 mx-auto max-w-2xl">
          <div className="inline-flex items-center gap-1.5 rounded-full border border-brand-700 bg-brand-900/80 px-4 py-1 text-xs font-semibold text-brand-200">
            <Sparkles className="h-3.5 w-3.5 text-accent-400" />
            <span>Start Free in 2 Minutes</span>
          </div>

          <h2 className="mt-4 font-display text-3xl font-extrabold tracking-tight text-white sm:text-4xl lg:text-5xl">
            Start with just one week of sales & receipt records
          </h2>

          <p className="mt-4 text-base leading-relaxed text-brand-100 sm:text-lg">
            That's usually enough for the recovery meter and AI assistant to start telling you something you didn't already know about your shop's profitability.
          </p>

          {/* Action Button Cluster */}
          <div className="mt-8 flex flex-wrap items-center justify-center gap-4">
            <ButtonLink
              to="/register"
              variant="primary"
              size="lg"
              className="bg-accent-400 text-ink-950 hover:bg-accent-300 font-bold shadow-xl shadow-accent-400/20 text-base px-8 py-3.5 rounded-xl transition"
            >
              <span>Create Your Free Account</span>
              <ArrowRight className="ml-2 h-4 w-4 stroke-[2.5]" />
            </ButtonLink>
          </div>

          {/* Zero-Risk Assurances */}
          <div className="mt-8 flex flex-wrap justify-center gap-6 text-xs text-brand-200">
            <div className="flex items-center gap-1.5">
              <CheckCircle2 className="h-4 w-4 text-accent-400" />
              <span>No credit card required</span>
            </div>
            <div className="flex items-center gap-1.5">
              <CheckCircle2 className="h-4 w-4 text-accent-400" />
              <span>Works on phone & laptop</span>
            </div>
            <div className="flex items-center gap-1.5">
              <ShieldCheck className="h-4 w-4 text-accent-400" />
              <span>Private storage, expiring links</span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
