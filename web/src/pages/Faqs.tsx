import { PublicLayout, PublicPageHead } from "../components/PublicLayout";
import { FAQ_TOPICS, FAQS } from "../lib/marketingContent";

/**
 * The full FAQ, grouped by topic.
 *
 * The landing page shows the first handful and links here. Both read the same
 * list from lib/marketingContent, so the short version can never disagree with
 * the long one.
 *
 * Native <details>/<summary> again: keyboard- and screen-reader-correct for
 * free, works with JS disabled, and — the reason it matters most on this page —
 * the browser's own find-in-page can reach text inside a closed answer.
 */
export function Faqs() {
  return (
    <PublicLayout>
      <PublicPageHead
        eyebrow="Help Center"
        title="Frequently Asked Questions"
        lede="What FinSight does, what it does not do, and what happens to your records. If your question isn't here, contact us."
      />

      <div className="mx-auto max-w-4xl px-4 py-12 lg:px-6 lg:py-16">
        {FAQ_TOPICS.map((topic) => {
          const inTopic = FAQS.filter((f) => f.topic === topic);
          if (inTopic.length === 0) return null;
          return (
            <section key={topic} className="mb-10 last:mb-0">
              <h2 className="font-display text-lg font-bold text-ink-900">{topic}</h2>
              <div className="mt-4 grid gap-3">
                {inTopic.map((f) => (
                  <details
                    key={f.q}
                    className="group rounded-xl border border-paper-200 bg-paper px-5 py-4 open:border-edge-brand"
                  >
                    <summary className="tap flex cursor-pointer list-none items-center justify-between gap-4 font-medium text-ink-900 marker:content-none">
                      <span>{f.q}</span>
                      <span
                        aria-hidden
                        className="shrink-0 text-lg leading-none text-tone-brand transition-transform group-open:rotate-45"
                      >
                        +
                      </span>
                    </summary>
                    <p className="mt-3 pr-8 text-sm leading-relaxed text-ink-600">{f.a}</p>
                  </details>
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </PublicLayout>
  );
}
