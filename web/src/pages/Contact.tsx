import { Link } from "react-router-dom";
import { PublicLayout, PublicPageHead } from "../components/PublicLayout";
import { SUPPORT_EMAIL } from "../lib/marketingContent";
import { CircleHelp, Mail, MessageSquareWarning } from "lucide-react";

/**
 * Contact.
 *
 * Deliberately NOT a form. A form implies a mailbox somewhere that a person
 * reads, and there is no endpoint behind one today — a contact form that
 * silently discards messages is worse than no contact page at all. When a
 * support address or an inbox exists, this becomes a form and the placeholder
 * below goes.
 *
 * The address lives in lib/marketingContent — one place to change it, and the
 * Android app's Contact screen shows the same one.
 */

export function Contact() {
  return (
    <PublicLayout>
      <PublicPageHead
        eyebrow="Help Center"
        title="Contact Us"
        lede="Questions, problems, or something FinSight read wrong — we would rather hear about it."
      />

      <div className="mx-auto max-w-[1240px] px-4 py-14 lg:px-6 lg:py-20">
        <div className="grid overflow-hidden rounded-2xl border border-landing-mint-light bg-landing-surface sm:grid-cols-2">
          <section className="p-6 sm:border-r sm:border-landing-mint-light lg:p-9">
            <span
              aria-hidden
              className="flex h-11 w-11 items-center justify-center rounded-xl bg-landing-mint-pale text-landing-green"
            >
              <Mail className="h-5 w-5" />
            </span>
            <h2 className="mt-4 font-landing-display text-lg font-semibold text-landing-charcoal">Email us</h2>
            <p className="mt-2 text-sm leading-relaxed text-landing-muted">
              The most reliable way to reach us. If a receipt was read wrong, saying which shop it came
              from helps more than anything else.
            </p>
            <p className="mt-4">
              <a href={`mailto:${SUPPORT_EMAIL}`} className="text-sm font-semibold text-landing-green underline-offset-4 hover:underline">
                {SUPPORT_EMAIL}
              </a>
            </p>
          </section>

          <section className="border-t border-landing-mint-light p-6 sm:border-t-0 lg:p-9">
            <span
              aria-hidden
              className="flex h-11 w-11 items-center justify-center rounded-xl bg-landing-mint-pale text-landing-green"
            >
              <CircleHelp className="h-5 w-5" />
            </span>
            <h2 className="mt-4 font-landing-display text-lg font-semibold text-landing-charcoal">Check the FAQs first</h2>
            <p className="mt-2 text-sm leading-relaxed text-landing-muted">
              Most questions — whether it works offline, what it costs, what happens to your receipt
              photos — are already answered there.
            </p>
            <p className="mt-4">
              <Link to="/faqs" className="text-sm font-semibold text-landing-green underline-offset-4 hover:underline">
                Read the FAQs
              </Link>
            </p>
          </section>
        </div>

        <div className="mt-10 flex gap-4 border-y border-landing-mint-light py-7">
          <MessageSquareWarning aria-hidden className="mt-0.5 h-5 w-5 shrink-0 text-landing-green" />
          <div>
            <h2 className="font-landing-display text-base font-semibold text-landing-charcoal">Reporting something FinSight got wrong</h2>
            <p className="mt-2 max-w-3xl text-sm leading-relaxed text-landing-muted">
              Receipt reading is the part most likely to be wrong, and the reports that actually help us
              fix it include the shop, what was printed, and what FinSight read instead. You do not need
              to send us the photo — the description is usually enough to reproduce it.
            </p>
          </div>
        </div>
      </div>
    </PublicLayout>
  );
}
