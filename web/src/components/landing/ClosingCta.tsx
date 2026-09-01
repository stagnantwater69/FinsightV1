import { Link } from "react-router-dom";
import { ArrowRight, Check } from "lucide-react";
import { CTA_PRIMARY, MEASURE, Rise } from "./grid";

/**
 * The closing conversion banner — the visual end of the Financial Trail.
 * Deep emerald, one gold CTA, and a small phone-and-receipts vignette with a
 * rising chart whose top node is gold. Reassurances stay inside what the
 * product actually promises.
 */
const REASSURANCES = ["No credit card required", "Works on phone & laptop", "Private storage, expiring links"];

export function ClosingCta() {
  return (
    <section aria-labelledby="cta-title" className={`${MEASURE} pb-16 pt-4 sm:pb-24`}>
      <Rise>
        <div className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-landing-emerald via-landing-emerald to-landing-emerald-2 px-6 py-10 sm:px-10 sm:py-14">
          {/* faint rising chart across the banner's foot */}
          <svg
            aria-hidden
            viewBox="0 0 400 80"
            preserveAspectRatio="none"
            className="pointer-events-none absolute inset-x-0 bottom-0 h-20 w-full opacity-[0.08]"
          >
            <path d="M0 70 L60 62 L120 66 L180 48 L240 54 L300 30 L360 36 L400 14" fill="none" stroke="#A9DEC9" strokeWidth="2" />
            <circle cx="300" cy="30" r="4" fill="#F5AD19" />
            <circle cx="400" cy="14" r="4" fill="#F5AD19" />
          </svg>

          <div className="relative grid items-center gap-x-10 gap-y-10 md:grid-cols-12">
            <div className="hidden md:col-span-3 md:block">
              {/* Generated on a near-#063F35 ground; the rounded frame makes
                  the remaining shade difference read as a photo panel. */}
              <img
                src="/landing/cta-phone.webp"
                alt=""
                width={832}
                height={640}
                loading="lazy"
                className="mx-auto w-full max-w-56 rounded-2xl shadow-lg"
              />
            </div>

            <div className="md:col-span-5">
              <h2
                id="cta-title"
                className="max-w-[20ch] font-landing-display text-[clamp(1.6rem,3.4vw,2.3rem)] font-extrabold leading-[1.12] tracking-[-0.02em] text-white"
              >
                Start with just one week of sales &amp; receipt records.
              </h2>
              <p className="mt-4 max-w-[46ch] text-[14.5px] leading-relaxed text-landing-mint/85">
                That's usually enough for the recovery meter and AI assistant to start telling you something you
                didn't already know about your shop's profitability.
              </p>
            </div>

            <div className="md:col-span-4">
              <Link to="/register" className={`${CTA_PRIMARY} group w-full sm:w-auto`}>
                Start Tracking Free
                <ArrowRight className="h-4 w-4 transition-transform duration-150 ease-shell group-hover:translate-x-0.5" aria-hidden />
              </Link>
              <ul className="mt-6 space-y-2.5">
                {REASSURANCES.map((r) => (
                  <li key={r} className="flex items-center gap-2.5 text-[13.5px] font-medium text-landing-mint">
                    <Check className="h-4 w-4 shrink-0 text-landing-gold" aria-hidden />
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
