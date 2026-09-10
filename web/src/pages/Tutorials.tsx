import { Link } from "react-router-dom";
import { PublicLayout, PublicPageHead } from "../components/PublicLayout";
import { TUTORIALS } from "../lib/marketingContent";

/**
 * Tutorials — one card per walkthrough that is planned.
 *
 * The steps live in lib/marketingContent so the Android app's Help section
 * teaches the same six, in the same order. Each card carries a "video coming
 * soon" marker rather than a play button that does nothing — a control that
 * looks live and isn't teaches a visitor something worse about the product
 * than an honest label.
 */

export function Tutorials() {
  return (
    <PublicLayout>
      <PublicPageHead
        eyebrow="Help Center"
        title="Tutorials"
        lede="Step by step, from setting up your business to reading what the dashboard is telling you."
      />

      <div className="mx-auto max-w-[1240px] px-4 py-14 lg:px-6 lg:py-20">
        <div className="grid gap-x-12 gap-y-0 lg:grid-cols-2">
          {TUTORIALS.map((t) => (
            <article key={t.n} className="border-b border-landing-mint-light py-7 first:pt-0 lg:[&:nth-child(2)]:pt-0">
              <div className="flex items-center gap-3">
                <span
                  aria-hidden
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-landing-green font-landing-display text-sm font-bold text-white"
                >
                  {t.n}
                </span>
                <h2 className="font-landing-display text-lg font-semibold text-landing-charcoal">{t.title}</h2>
              </div>
              <p className="mt-3 text-sm leading-relaxed text-landing-muted">{t.body}</p>
              <p className="mt-4 text-xs font-semibold text-landing-green">Video walkthrough coming soon</p>
            </article>
          ))}
        </div>

        <div className="mt-12 flex flex-col items-center justify-between gap-5 rounded-2xl bg-landing-emerald px-6 py-7 text-center sm:flex-row sm:text-left lg:px-8">
          <p className="max-w-xl text-sm leading-relaxed text-white/85">
            The quickest way to learn it is to record one week of your own figures.
          </p>
          <div className="mt-4">
            <Link
              to="/register"
              className="tap inline-flex whitespace-nowrap rounded-full bg-landing-gold px-5 text-sm font-bold text-landing-emerald transition hover:brightness-95"
            >
              Create a free account
            </Link>
          </div>
        </div>
      </div>
    </PublicLayout>
  );
}
