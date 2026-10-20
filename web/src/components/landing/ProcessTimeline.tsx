import { ArrowRight, Camera } from "lucide-react";
import { MEASURE, Rise, SectionHead } from "./grid";
import { DashboardPreview, ReceiptReviewPreview } from "./LandingPreviews";

const STEPS = [
  { title: "Capture", body: "Add a sale or scan a receipt." },
  { title: "Review", body: "Check the details before saving." },
  { title: "Understand", body: "Review your totals and ask questions." },
];

function StepPreview({ step }: { step: number }) {
  if (step === 0) {
    return (
      <div className="relative h-full overflow-hidden rounded-xl">
        <img src="/landing/receipt-capture.webp" alt="A shop owner photographs a receipt with a phone" width={1122} height={1402} loading="lazy" className="h-full w-full object-cover object-[center_60%]" />
        <span className="absolute bottom-3 right-3 flex h-12 w-12 items-center justify-center rounded-full border-2 border-white bg-landing-green text-white shadow-sm">
          <Camera className="h-6 w-6" aria-hidden />
        </span>
      </div>
    );
  }
  return (
    <div className={`landing-hero-demo flex h-full items-start overflow-hidden rounded-xl border border-landing-mint-light bg-white p-3 shadow-sm [&>.lp-dashboard]:w-full [&>.lp-review]:w-full ${step === 2 ? "lp-process-dashboard" : ""}`}>
      {step === 1 ? <ReceiptReviewPreview compact /> : <DashboardPreview compact />}
    </div>
  );
}

export function ProcessTimeline() {
  return (
    <section id="how-it-works" aria-labelledby="process-title" className="scroll-mt-20 bg-landing-cream">
      <div className={`${MEASURE} pb-16 pt-2 sm:pb-20 sm:pt-4`}>
        <SectionHead eyebrow="How it works" id="process-title" title="How FinSight works for your shop" />
        <ol className="mt-7 grid gap-9 md:grid-cols-3 md:gap-10 lg:gap-16">
          {STEPS.map((step, index) => (
            <li key={step.title} className="relative min-w-0">
              <Rise delay={index * 65}>
                <div className="mb-3 flex items-center gap-3">
                  <span aria-hidden className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-landing-emerald font-landing-display text-lg font-bold text-white">{index + 1}</span>
                  <h3 className="font-landing-display text-xl font-bold tracking-[-0.025em] text-landing-charcoal">{step.title}</h3>
                </div>
                <div className="h-[220px] sm:h-[250px] md:h-[200px] lg:h-[230px]">
                  <StepPreview step={index} />
                </div>
                <p className="mt-3 text-sm leading-relaxed text-landing-muted">{step.body}</p>
              </Rise>
              {index < STEPS.length - 1 ? (
                <ArrowRight aria-hidden className="absolute -bottom-7 left-1/2 h-5 w-5 -translate-x-1/2 rotate-90 text-landing-green md:-right-8 md:bottom-auto md:left-auto md:top-1/2 md:translate-x-0 md:rotate-0 lg:-right-11" />
              ) : null}
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
