import { Card, MEASURE, Rise, SectionHead } from "./grid";

/**
 * How it works: three numbered cards joined by a dotted Financial Trail with
 * gold nodes at the joins. Horizontal on desktop, a vertical trail when the
 * cards stack.
 */

const STEPS = [
  {
    n: "01",
    title: "Record daily sales & expenses",
    body: "Type sales, or scan and snap receipt photos with your phone or web — FinSight logs them automatically.",
    highlight: "3 minutes a day",
  },
  {
    n: "02",
    title: "See your actual profit & recovery space",
    body: "FinSight calculates your profit daily to help you run wisely: a real buffer for expenses, loans and goals.",
    highlight: "Real time. Daily. Trusted.",
  },
  {
    n: "03",
    title: "Ask FinSight anything in plain language",
    body: "Ask questions like “Why was expenses higher this week?” and get answers you can act on today.",
    highlight: "Answers in seconds",
  },
];

/** The dotted trail joining two step cards, with a gold node at its middle. */
function TrailJoin() {
  return (
    <div aria-hidden className="flex items-center justify-center py-1 md:py-0">
      {/* horizontal on md+, vertical when stacked */}
      <svg viewBox="0 0 56 24" className="hidden h-6 w-14 md:block">
        <line x1="0" y1="12" x2="56" y2="12" stroke="#A9DEC9" strokeWidth="2" strokeDasharray="1 6" strokeLinecap="round" />
        <circle cx="28" cy="12" r="4" fill="#F5AD19" />
      </svg>
      <svg viewBox="0 0 24 40" className="h-10 w-6 md:hidden">
        <line x1="12" y1="0" x2="12" y2="40" stroke="#A9DEC9" strokeWidth="2" strokeDasharray="1 6" strokeLinecap="round" />
        <circle cx="12" cy="20" r="4" fill="#F5AD19" />
      </svg>
    </div>
  );
}

export function ProcessTimeline() {
  return (
    <section
      id="how-it-works"
      aria-labelledby="process-title"
      className="landing-section-gradient-raised relative scroll-mt-20 overflow-hidden bg-landing-cream"
    >

      <div className={`${MEASURE} relative py-16 sm:py-24`}>
        <SectionHead
          eyebrow="How it works"
          id="process-title"
          title="How FinSight works for your shop"
        />

        <ol className="mt-10 grid items-stretch gap-0 md:grid-cols-[1fr_auto_1fr_auto_1fr] md:gap-1">
          {STEPS.map((s, i) => (
            <li key={s.n} className="contents">
              {i > 0 ? <TrailJoin /> : null}
              <Rise delay={i * 100} className="h-full">
                <Card hover className="flex h-full flex-col p-6">
                  <div className="flex items-center justify-between gap-3">
                    <span
                      aria-hidden
                      className="flex h-11 w-11 items-center justify-center landing-step-badge rounded-2xl font-landing-display text-lg font-extrabold text-white"
                    >
                      {i + 1}
                    </span>
                    <span className="rounded-full bg-landing-mint-pale px-3 py-1.5 font-landing-sans text-xs font-semibold text-landing-green">
                      {s.highlight}
                    </span>
                  </div>
                  <h3 className="mt-5 max-w-[18ch] font-landing-display text-[17px] font-bold leading-snug text-landing-charcoal">
                    {s.title}
                  </h3>
                  <p className="mt-2.5 flex-1 text-[14px] leading-relaxed text-landing-muted">{s.body}</p>
                </Card>
              </Rise>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
