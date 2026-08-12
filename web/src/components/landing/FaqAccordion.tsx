import { useState } from "react";
import { Link } from "react-router-dom";
import { ChevronDown, HelpCircle, ArrowRight } from "lucide-react";
import { FAQS, LANDING_FAQ_COUNT } from "../../lib/marketingContent";

/**
 * The landing page FAQ.
 *
 * SOURCED FROM lib/marketingContent, not from a list of its own. It previously
 * carried a private copy, which had already drifted into claims the shared one
 * is careful about — that receipt images sit in "encrypted" buckets, and that
 * figures are "never shared with outside entities". The second is simply
 * false: reading a receipt sends the image to a third-party model, and
 * answering a question sends figures from the owner's records. Saying
 * otherwise on the page where a visitor decides whether to trust the product
 * is the worst place to be wrong.
 *
 * One list also means the eight shown here can never disagree with the full
 * set on /faqs.
 *
 * TWO COLUMNS via CSS `columns` rather than a two-column grid. That matters
 * once an answer can expand: a grid of two halves leaves one column short and
 * shoves the other's rows around as items open. `break-inside-avoid` keeps a
 * question with its answer, and at one column the reading order is still the
 * source order.
 */
export function FaqAccordion() {
  const [openQuestion, setOpenQuestion] = useState<string | null>(null);
  const shown = FAQS.slice(0, LANDING_FAQ_COUNT);

  return (
    <section id="faq" className="scroll-mt-24 border-t border-paper-200/80 bg-paper-50/50 py-16 lg:py-24">
      <div className="mx-auto max-w-5xl px-4 lg:px-6">
        <div className="text-center">
          <div className="inline-flex items-center gap-1.5 rounded-full border border-brand-200 bg-tint-brand px-3.5 py-1 text-xs font-semibold text-brand-800">
            <HelpCircle className="h-3.5 w-3.5 text-brand-600" />
            <span>Got Questions?</span>
          </div>
          <h2 className="mt-3 font-display text-3xl font-bold tracking-tight text-ink-900 sm:text-4xl">
            Frequently Asked Questions
          </h2>
          <p className="mt-3 text-base text-ink-600">
            What FinSight does, what it does not do, and what happens to your records.
          </p>
        </div>

        <div className="mt-10 gap-4 sm:columns-2">
          {shown.map((faq) => {
            const isOpen = openQuestion === faq.q;
            return (
              <div
                key={faq.q}
                className={`mb-4 break-inside-avoid overflow-hidden rounded-2xl border bg-paper transition-colors ${
                  isOpen ? "border-brand-300 shadow-md" : "border-paper-200 hover:border-paper-300"
                }`}
              >
                <button
                  type="button"
                  onClick={() => setOpenQuestion(isOpen ? null : faq.q)}
                  aria-expanded={isOpen}
                  className="flex w-full items-center justify-between gap-4 px-5 py-4 text-left text-sm font-semibold text-ink-900"
                >
                  <span>{faq.q}</span>
                  <ChevronDown
                    className={`h-5 w-5 shrink-0 text-brand-600 transition-transform duration-200 ${
                      isOpen ? "rotate-180" : ""
                    }`}
                  />
                </button>

                {isOpen && (
                  <div className="border-t border-paper-200/60 bg-paper-50/50 px-5 py-4 text-sm leading-relaxed text-ink-600">
                    {faq.a}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="mt-10 text-center">
          <Link
            to="/faqs"
            className="inline-flex items-center gap-2 rounded-xl border border-paper-200 bg-paper px-6 py-3 text-sm font-semibold text-ink-900 shadow-xs transition-colors hover:bg-paper-100"
          >
            See All FAQs
            <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
      </div>
    </section>
  );
}
