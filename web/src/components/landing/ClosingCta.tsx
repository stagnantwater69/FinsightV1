import { Link } from "react-router-dom";
import { ArrowRight, Check } from "lucide-react";
import { CTA_PRIMARY, MEASURE, Rise } from "./grid";
import "./landing-preview.css";

const REASSURANCES = ["No credit card required", "Works on phone & web"];

export function ClosingCta() {
  return (
    <section aria-labelledby="cta-title" className={`${MEASURE} pb-12 pt-1 sm:pb-14`}>
      <Rise>
        <div className="lp-closing-surface relative overflow-hidden rounded-2xl border border-landing-mint-light">
          <svg
            aria-hidden
            viewBox="0 0 400 80"
            preserveAspectRatio="none"
            className="pointer-events-none absolute inset-x-0 bottom-0 h-20 w-full text-landing-green opacity-[0.14]"
          >
            <path d="M0 70 L60 62 L120 66 L180 48 L240 54 L300 30 L360 36 L400 14" fill="none" stroke="currentColor" strokeWidth="2" />
            <circle cx="300" cy="30" r="3" fill="currentColor" />
            <circle cx="400" cy="14" r="3" fill="currentColor" />
          </svg>

          <div className="lp-closing-layout relative grid items-center gap-x-6 gap-y-5 md:grid-cols-[0.85fr_1.3fr] lg:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)_minmax(15.5rem,0.92fr)] lg:gap-x-16">
            <figure className="lp-closing-art self-stretch md:row-span-2 lg:row-span-1">
              <img
                src="/landing/cta-woman-phone.webp"
                alt="A woman holding a phone displaying the FinSight mobile dashboard."
                width={1254}
                height={1254}
                loading="lazy"
                decoding="async"
              />
            </figure>

            <div className="px-6 pt-1 md:col-start-2 md:px-0 md:pr-6 md:pt-7 lg:py-7 lg:pr-0">
              <h2
                id="cta-title"
                className="max-w-[29ch] font-landing-display text-[clamp(1.5rem,2.6vw,1.9rem)] font-extrabold leading-[1.13] tracking-[-0.025em] text-landing-charcoal"
              >
                Start with just one week of sales &amp; receipt records.
              </h2>
              <p className="mt-3 max-w-[35ch] text-sm leading-relaxed text-landing-muted">
                Build a clearer picture from the records you already have.
              </p>
            </div>

            <div className="px-6 pb-7 md:col-start-2 md:pl-0 lg:col-start-3 lg:py-7 lg:pr-6">
              <Link to="/register" className={`${CTA_PRIMARY} group w-full sm:w-auto lg:whitespace-nowrap`}>
                Start Tracking Free
                <ArrowRight className="h-4 w-4 transition-transform duration-150 ease-shell group-hover:translate-x-0.5" aria-hidden />
              </Link>
              <ul className="mt-4 space-y-2">
                {REASSURANCES.map((r) => (
                  <li key={r} className="flex items-center gap-2.5 text-[13.5px] font-medium text-landing-muted">
                    <Check className="h-4 w-4 shrink-0 text-landing-green" aria-hidden />
                    {r}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </Rise>
    </section>
  );
}
