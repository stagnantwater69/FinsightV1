import { useId, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, ChevronDown } from "lucide-react";
import { FAQS } from "../../lib/marketingContent";
import { Card, Eyebrow, MEASURE, Rise } from "./grid";

const LANDING_QUESTIONS = [
  "What is FinSight and who is it for?",
  "Do I need to know accounting to use it?",
  "Can I bring in records I already keep in a spreadsheet?",
  "What if it reads my receipt wrong?",
  "Is FinSight available on mobile and desktop?",
  "Does the AI assistant see my records?",
];

const SHOWN_FAQS = LANDING_QUESTIONS.flatMap((question) => FAQS.filter((faq) => faq.q === question));
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
            className="flex min-h-tap w-full items-center justify-between gap-4 px-5 py-3.5 text-left transition-colors duration-150 hover:bg-landing-mint-pale/50 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-4 focus-visible:outline-landing-green"
          >
            <span className="text-[13px] font-bold leading-relaxed text-landing-charcoal">{q}</span>
            <ChevronDown
              aria-hidden
              className={`h-4 w-4 shrink-0 text-landing-green transition-transform duration-200 ease-shell motion-reduce:transition-none ${
                open ? "rotate-180" : ""
              }`}
            />
          </button>
        </h3>
        <div
          id={panelId}
          role="region"
          aria-labelledby={buttonId}
          hidden={!open}
        >
          <div className="overflow-hidden">
            <p className="px-5 pb-4 text-sm leading-relaxed text-landing-muted">{a}</p>
          </div>
        </div>
      </Card>
    </Rise>
  );
}

export function FaqAccordion() {
  const [openQuestion, setOpenQuestion] = useState<string | null>(SHOWN_FAQS[0]?.q ?? null);
  const mid = Math.ceil(SHOWN_FAQS.length / 2);
  const columns = [SHOWN_FAQS.slice(0, mid), SHOWN_FAQS.slice(mid)];

  return (
    <section
      id="faq"
      aria-labelledby="faq-title"
      className="scroll-mt-20 bg-landing-cream"
    >
      <div className={`${MEASURE} pb-8 pt-12 sm:pb-10 sm:pt-14`}>
        <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
          <Rise>
            <Eyebrow>FAQ</Eyebrow>
            <h2 id="faq-title" className="mt-2 font-landing-display text-[clamp(1.5rem,2.8vw,2rem)] font-extrabold leading-tight tracking-[-0.025em] text-landing-charcoal">Frequently Asked Questions</h2>
          </Rise>
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

        <div className="mt-5 grid gap-2.5 md:grid-cols-2 md:items-start md:gap-6">
          {columns.map((col, ci) => (
            <div key={ci} className="grid gap-2.5">
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
