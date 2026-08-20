import { useId, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, ChevronDown } from "lucide-react";
import { FAQS, LANDING_FAQ_COUNT } from "../../lib/marketingContent";
import { Card, MEASURE, Rise, SectionHead } from "./grid";

/**
 * The FAQ: card accordions in two columns on desktop, one open at a time.
 *
 * Height animates via the grid-rows 0fr→1fr trick — pure CSS, no measuring,
 * no layout jump, and with JS animation disabled the content still simply
 * appears (the transition is decoration on top of a working toggle). Each
 * trigger is a real button with aria-expanded/aria-controls, and the answer
 * region points back with aria-labelledby.
 */
function FaqItem({
  q,
  a,
  open,
  onToggle,
  delay,
}: {
  q: string;
  a: string;
  open: boolean;
  onToggle: () => void;
  delay: number;
}) {
  const id = useId();
  const buttonId = `faq-q-${id}`;
  const panelId = `faq-a-${id}`;

  return (
    <Rise delay={delay}>
      <Card className="overflow-hidden">
        <h3>
          <button
            type="button"
            id={buttonId}
            aria-expanded={open}
            aria-controls={panelId}
            onClick={onToggle}
            className="flex min-h-tap w-full items-center justify-between gap-4 px-5 py-4 text-left transition-colors duration-150 hover:bg-landing-mint-pale/50"
          >
            <span className="font-display text-[15px] font-bold leading-snug text-landing-charcoal">{q}</span>
            <ChevronDown
              aria-hidden
              className={`h-4 w-4 shrink-0 text-landing-green transition-transform duration-250 ease-shell ${
                open ? "rotate-180" : ""
              }`}
            />
          </button>
        </h3>
        <div
          id={panelId}
          role="region"
          aria-labelledby={buttonId}
          className={`grid transition-[grid-template-rows,opacity] duration-250 ease-shell ${
            open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"
          }`}
        >
          <div className="overflow-hidden">
            <p className="px-5 pb-5 text-[14px] leading-relaxed text-landing-muted">{a}</p>
          </div>
        </div>
      </Card>
    </Rise>
  );
}

export function FaqAccordion() {
  const [openQuestion, setOpenQuestion] = useState<string | null>(null);
  const shown = FAQS.slice(0, LANDING_FAQ_COUNT);
  // Two source-ordered columns (not CSS columns), so reading order survives.
  const mid = Math.ceil(shown.length / 2);
  const columns = [shown.slice(0, mid), shown.slice(mid)];

  return (
    <section id="faq" aria-labelledby="faq-title" className="scroll-mt-20 bg-landing-cream">
      <div className={`${MEASURE} py-16 sm:py-24`}>
        <div className="flex flex-wrap items-end justify-between gap-6">
          <SectionHead
            eyebrow="FAQ"
            id="faq-title"
            title="Frequently Asked Questions"
            lede="What FinSight does, what it does not do, and what happens to your records."
          />
          <Rise delay={100}>
            <Link
              to="/faqs"
              className="inline-flex min-h-tap items-center gap-1.5 rounded-lg px-2 text-[14px] font-bold text-landing-green transition-colors hover:text-landing-emerald"
            >
              See all FAQs
              <ArrowRight className="h-4 w-4" aria-hidden />
            </Link>
          </Rise>
        </div>

        <div className="mt-10 grid gap-4 md:grid-cols-2 md:items-start">
          {columns.map((col, ci) => (
            <div key={ci} className="grid gap-4">
              {col.map((faq, i) => (
                <FaqItem
                  key={faq.q}
                  q={faq.q}
                  a={faq.a}
                  open={openQuestion === faq.q}
                  onToggle={() => setOpenQuestion(openQuestion === faq.q ? null : faq.q)}
                  delay={Math.min(ci * mid + i, 5) * 40}
                />
              ))}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
