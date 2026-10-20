import { Link } from "react-router-dom";
import { ArrowRight } from "lucide-react";
import { CTA_PRIMARY, MEASURE } from "./grid";
import { NotebookComparisonPreview } from "./LandingPreviews";

export function HeroSection() {
  return (
    <section id="home" aria-labelledby="hero-title" className="landing-hero-surface relative overflow-hidden">
      <div className={`${MEASURE} relative pb-6 pt-10 sm:pb-7 sm:pt-14 lg:pt-16 short:pt-6`}>
        <div className="mx-auto text-center">
          <h1 id="hero-title" className="mx-auto max-w-[1000px] font-landing-display text-[clamp(2.25rem,5.2vw,4.2rem)] font-extrabold short:text-[clamp(1.75rem,4vw,2.5rem)] leading-[1.06] tracking-[-0.045em] text-landing-charcoal">
            Know where your money
            <br className="hidden sm:inline" />{" "}
            actually goes{" "}
            <span className="italic text-landing-green">
              before the<br className="hidden sm:inline" /> month ends.
            </span>
          </h1>
          <p className="mx-auto mt-5 max-w-[46rem] font-landing-sans text-base leading-relaxed text-landing-muted sm:text-lg">
            Turn daily sales and supplier receipts into a clearer view of your business.
            <br className="hidden sm:inline" /> Ask financial questions in plain language.
          </p>
          <div className="mt-6 flex justify-center">
            <Link to="/register" className={CTA_PRIMARY}>Start Tracking Free<ArrowRight className="h-4 w-4" aria-hidden /></Link>
          </div>
          <ul className="mt-5 flex flex-wrap items-center justify-center gap-x-7 gap-y-2 font-landing-sans text-[13px] text-landing-muted sm:text-sm">
            {["Built for small businesses", "Answers from your own records"].map((item) => (
              <li className="flex items-center gap-2" key={item}><span className="h-1.5 w-1.5 shrink-0 rounded-full bg-landing-green" aria-hidden />{item}</li>
            ))}
          </ul>
        </div>
        <figure className="m-0">
          <NotebookComparisonPreview />
        </figure>
      </div>
    </section>
  );
}
