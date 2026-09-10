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

      <div className="mx-auto max-w-[1240px] px-4 py-14 lg:px-6 lg:py-20">
        {FAQ_TOPICS.map((topic) => {
          const inTopic = FAQS.filter((f) => f.topic === topic);
          if (inTopic.length === 0) return null;
          return (
            <section key={topic} className="mb-12 grid gap-5 last:mb-0 md:grid-cols-[minmax(11rem,0.38fr)_minmax(0,1fr)] md:gap-12">
              <h2 className="font-landing-display text-lg font-bold text-landing-charcoal">{topic}</h2>
              <div className="mt-4 grid gap-3">
                {inTopic.map((f) => (
                  <details
                    key={f.q}
                    className="group border-b border-landing-mint-light py-4 first:pt-0"
                  >
                    <summary className="tap flex cursor-pointer list-none items-center justify-between gap-4 font-semibold text-landing-charcoal marker:content-none">
                      <span>{f.q}</span>
                      <span
                        aria-hidden
                        className="shrink-0 text-lg leading-none text-landing-green transition-transform group-open:rotate-45"
                      >
                        +
                      </span>
                    </summary>
                    <p className="mt-3 max-w-3xl pr-8 text-sm leading-relaxed text-landing-muted">{f.a}</p>
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
