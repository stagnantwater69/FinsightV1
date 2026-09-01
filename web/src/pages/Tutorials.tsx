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

      <div className="mx-auto max-w-4xl px-4 py-12 lg:px-6 lg:py-16">
        <div className="grid gap-4 sm:grid-cols-2">
          {TUTORIALS.map((t) => (
            <article key={t.n} className="rounded-2xl border border-paper-200 bg-paper p-5">
              <div className="flex items-center gap-3">
                <span
                  aria-hidden
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-700 font-display text-sm font-bold text-white"
                >
                  {t.n}
                </span>
                <h2 className="font-display text-base font-semibold text-ink-900">{t.title}</h2>
              </div>
              <p className="mt-3 text-sm leading-relaxed text-ink-600">{t.body}</p>
              <p className="mt-4 text-xs font-medium text-ink-400">Video walkthrough coming soon</p>
            </article>
          ))}
        </div>

        <div className="mt-10 rounded-2xl border border-edge-brand bg-tint-brand/40 p-6 text-center">
          <p className="text-sm text-ink-700">
            The quickest way to learn it is to record one week of your own figures.
          </p>
          <div className="mt-4">
            <Link
              to="/register"
              className="tap inline-flex rounded-lg bg-accent-400 px-5 text-sm font-semibold text-ink-900 hover:bg-accent-500"
            >
              Create a free account
            </Link>
          </div>
        </div>
      </div>
    </PublicLayout>
  );
}
