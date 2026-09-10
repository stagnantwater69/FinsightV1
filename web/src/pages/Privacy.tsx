import { PublicLayout, PublicPageHead } from "../components/PublicLayout";
import { LEGAL_DISCLAIMER_HEADING, PRIVACY_DISCLAIMER, PRIVACY_SECTIONS } from "../lib/marketingContent";

/**
 * Privacy — a plain description of what the system actually does with data.
 *
 * The prose moved to lib/marketingContent when the Android app grew its own
 * Help section. It is the same document on both platforms and it has to stay
 * that way: the panel found most owners have a phone and no computer, so the
 * app is where this will actually be read, and a privacy notice that says two
 * different things depending on where you read it is worse than one that says
 * nothing. See that file's header for why every claim in it is checkable
 * against the code rather than drafted to look reassuring.
 */
export function Privacy() {
  return (
    <PublicLayout>
      <PublicPageHead
        eyebrow="Legal"
        title="Privacy"
        lede="What FinSight stores, where it goes, and who can reach it — in plain language."
      />

      <div className="mx-auto max-w-[1240px] px-4 py-14 lg:px-6 lg:py-20">
        <article className="max-w-[72ch] space-y-10 text-base leading-7 text-landing-muted">
          {PRIVACY_SECTIONS.map((section) => (
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
              <strong className="font-semibold">{LEGAL_DISCLAIMER_HEADING}</strong> {PRIVACY_DISCLAIMER}
            </p>
          </div>
        </article>
      </div>
    </PublicLayout>
  );
}
