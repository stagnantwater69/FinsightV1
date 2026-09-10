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
        eyebrow="Legal"
        title="Terms of Use"
        lede="What FinSight is for, what it is not for, and what you can expect from it."
      />

      <div className="mx-auto max-w-[1240px] px-4 py-14 lg:px-6 lg:py-20">
        <article className="max-w-[72ch] space-y-10 text-base leading-7 text-landing-muted">
          {TERMS_SECTIONS.map((section) => (
            <section key={section.heading}>
              <h2 className="font-landing-display text-xl font-bold text-landing-charcoal">{section.heading}</h2>
              {section.body.map((paragraph) => (
                <p key={paragraph} className="mt-2">
                  {paragraph}
                </p>
              ))}
            </section>
          ))}

          <div className="border-y border-landing-mint-light bg-landing-mint-pale/40 px-5 py-6">
            <p className="text-landing-charcoal">
              <strong className="font-semibold">{LEGAL_DISCLAIMER_HEADING}</strong> {TERMS_DISCLAIMER}
            </p>
          </div>
        </article>
      </div>
    </PublicLayout>
  );
}
