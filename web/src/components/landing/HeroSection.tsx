import { Link } from "react-router-dom";
import { ArrowRight } from "lucide-react";
import { CTA_PRIMARY, MEASURE, Rise } from "./grid";

export function HeroSection() {
  return (
    <section
      id="home"
      aria-labelledby="hero-title"
      className="landing-hero-surface relative overflow-hidden"
    >
      <div className={`${MEASURE} relative pb-16 pt-14 sm:pt-20 lg:pb-24`}>
        {/* No measure cap of its own: the headline's line breaks are authored
            below, so a `ch` cap here would only fight them and force a fourth
            line. The section's 1240px MEASURE is the outer limit. The subtitle
            keeps its own 46rem, so the headline still runs ahead of it. */}
        <div className="mx-auto text-center">
          <Rise delay={70}>
            <h1
              id="hero-title"
              className="mx-auto mt-6 font-landing-display text-[clamp(2.2rem,5.2vw,3.7rem)] font-extrabold leading-[1.06] tracking-[-0.028em] text-landing-charcoal"
            >
              {/* Both breaks are authored rather than left to the wrap. Left to
                  itself the line count swings with viewport width — the same
                  copy sets as two lines on a wide display and four on a narrow
                  one. Gated to sm+ so small screens, where the measure runs out
                  long before either point, still wrap naturally. */}
              Know where your money
              <br className="hidden sm:inline" />{" "}
              actually goes{" "}
              <span className="italic text-landing-green">
                before the
                <br className="hidden sm:inline" /> month ends.
              </span>
            </h1>
          </Rise>

          <Rise delay={140}>
            {/* Held a step below the headline rather than matched to it: the
                headline now runs three lines at 3.7rem, and a lede at `text-lg`
                under that reads as a second heading instead of support. */}
            <p className="mx-auto mt-4 max-w-[42rem] font-landing-sans text-sm leading-relaxed text-landing-muted sm:text-base">
              FinSight turns your daily sales and supplier receipts into real-time profit clarity, with an AI
              assistant that answers your financial questions in plain language.
            </p>
          </Rise>

          <Rise delay={210}>
            <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
              <Link to="/register" className={CTA_PRIMARY}>
                Start Tracking Free
                <ArrowRight className="h-4 w-4" aria-hidden />
              </Link>
            </div>
          </Rise>

          <Rise delay={260}>
            <ul className="mt-7 flex flex-wrap items-center justify-center gap-x-7 gap-y-2 font-landing-sans text-sm font-medium text-landing-charcoal/80">
              <li className="flex items-center gap-2">
                <span className="h-1.5 w-1.5 rounded-full bg-landing-green" aria-hidden />
                Real-time insights
              </li>
              <li className="flex items-center gap-2">
                <span className="h-1.5 w-1.5 rounded-full bg-landing-green" aria-hidden />
                Built for small businesses
              </li>
              <li className="flex items-center gap-2">
                <span className="h-1.5 w-1.5 rounded-full bg-landing-green" aria-hidden />
                Answers from your own records
              </li>
            </ul>
          </Rise>
        </div>
      </div>
    </section>
  );
}
