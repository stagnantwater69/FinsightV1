import { Link } from "react-router-dom";
import { PublicLayout, PublicPageHead } from "../components/PublicLayout";
import { SUPPORT_EMAIL } from "../lib/marketingContent";

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

      <div className="mx-auto max-w-4xl px-4 py-12 lg:px-6 lg:py-16">
        <div className="grid gap-5 sm:grid-cols-2">
          <div className="rounded-2xl border border-paper-200 bg-paper p-6">
            <span
              aria-hidden
              className="flex h-11 w-11 items-center justify-center rounded-xl bg-tint-brand text-lg text-tone-brand"
            >
              ✉
            </span>
            <h2 className="mt-4 font-display text-base font-semibold text-ink-900">Email us</h2>
            <p className="mt-2 text-sm leading-relaxed text-ink-600">
              The most reliable way to reach us. If a receipt was read wrong, saying which shop it came
              from helps more than anything else.
            </p>
            <p className="mt-4">
              <a href={`mailto:${SUPPORT_EMAIL}`} className="text-sm font-semibold text-tone-brand hover:underline">
                {SUPPORT_EMAIL}
              </a>
            </p>
          </div>

          <div className="rounded-2xl border border-paper-200 bg-paper p-6">
            <span
              aria-hidden
              className="flex h-11 w-11 items-center justify-center rounded-xl bg-tint-brand text-lg text-tone-brand"
            >
              ?
            </span>
            <h2 className="mt-4 font-display text-base font-semibold text-ink-900">Check the FAQs first</h2>
            <p className="mt-2 text-sm leading-relaxed text-ink-600">
              Most questions — whether it works offline, what it costs, what happens to your receipt
              photos — are already answered there.
            </p>
            <p className="mt-4">
              <Link to="/faqs" className="text-sm font-semibold text-tone-brand hover:underline">
                Read the FAQs →
              </Link>
            </p>
          </div>
        </div>

        <div className="mt-8 rounded-2xl border border-paper-200 bg-paper-100/60 p-6">
          <h2 className="font-display text-base font-semibold text-ink-900">
            Reporting something FinSight got wrong
          </h2>
          <p className="mt-2 text-sm leading-relaxed text-ink-600">
            Receipt reading is the part most likely to be wrong, and the reports that actually help us
            fix it include the shop, what was printed, and what FinSight read instead. You do not need
            to send us the photo — the description is usually enough to reproduce it.
          </p>
        </div>
      </div>
    </PublicLayout>
  );
}
