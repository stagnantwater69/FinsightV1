import { PublicLayout, PublicPageHead } from "../components/PublicLayout";
import { LEGAL_DISCLAIMER_HEADING, TERMS_DISCLAIMER, TERMS_SECTIONS } from "../lib/marketingContent";

/**
 * Terms — honest usage terms, not generated legal boilerplate.
 *
 * Same reasoning as the privacy page: a document that mimics reviewed legal
 * text would be asserting a position nobody has actually taken. What is here
 * instead is the set of things a user genuinely needs to know before relying
 * on this software — chiefly that it is a monitoring tool and not an
 * accounting record of authority, which is the one misunderstanding that could
 * actually cost someone money.
 *
 * The prose lives in lib/marketingContent so the Android app renders the same
 * document rather than a second copy of it.
 */
export function Terms() {
  return (
    <PublicLayout>
      <PublicPageHead
        eyebrow="Others"
        title="Terms of Use"
        lede="What FinSight is for, what it is not for, and what you can expect from it."
      />

      <div className="mx-auto max-w-3xl px-4 py-12 lg:px-6 lg:py-16">
        <div className="space-y-8 text-sm leading-relaxed text-ink-600">
          {TERMS_SECTIONS.map((section) => (
            <section key={section.heading}>
              <h2 className="font-display text-lg font-bold text-ink-900">{section.heading}</h2>
              {section.body.map((paragraph) => (
                <p key={paragraph} className="mt-2">
                  {paragraph}
                </p>
              ))}
            </section>
          ))}

          <div className="rounded-2xl border border-edge-brand bg-tint-brand/40 p-5">
            <p className="text-ink-700">
              <strong className="font-semibold">{LEGAL_DISCLAIMER_HEADING}</strong> {TERMS_DISCLAIMER}
            </p>
          </div>
        </div>
      </div>
    </PublicLayout>
  );
}
