import { FileText, Lock, MessageSquare, UserRound, type LucideIcon } from "lucide-react";
import { MEASURE, Rise, SectionHead } from "./grid";

const SAFEGUARDS: { icon: LucideIcon; title: string; body: string }[] = [
  { icon: Lock, title: "Business-scoped records", body: "Access is checked against your active business." },
  { icon: FileText, title: "Private receipt photos", body: "Photo access uses expiring links." },
  { icon: MessageSquare, title: "Answers from your records", body: "Ask FinSight uses your active business context." },
  { icon: UserRound, title: "You confirm the details", body: "Review scanned results before saving." },
];

export function SafeguardsGrid() {
  return (
    <section aria-labelledby="safeguards-title" className="bg-landing-emerald text-white">
      <div className={`${MEASURE} grid gap-8 py-10 sm:py-12 lg:grid-cols-[0.95fr_1.65fr] lg:items-center lg:gap-12`}>
        <div className="lg:border-r lg:border-landing-mint/25 lg:pr-10">
          <SectionHead
            eyebrow="Your privacy, our priority"
            id="safeguards-title"
            title="Your records stay yours"
            lede="Clear safeguards for your business records."
            tone="dark"
          />
        </div>
        <div className="grid gap-x-7 sm:grid-cols-2">
          {SAFEGUARDS.map(({ icon: Icon, title, body }, index) => (
            <Rise key={title} delay={index * 40}>
              <div className={`flex h-full gap-4 py-4 ${index < 2 ? "border-b border-landing-mint/25" : ""}`}>
                <Icon className="mt-1 h-7 w-7 shrink-0 text-landing-mint" strokeWidth={1.5} aria-hidden />
                <div>
                  <h3 className="text-sm font-bold text-white">{title}</h3>
                  <p className="mt-1 text-sm leading-relaxed text-landing-mint">{body}</p>
                </div>
              </div>
            </Rise>
          ))}
        </div>
      </div>
    </section>
  );
}
