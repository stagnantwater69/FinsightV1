import { useState, type ReactNode } from "react";
import { useBusinessProfiles } from "../context/BusinessProfileContext";
import { EmptyState } from "./EmptyState";
import { ButtonLink, Button } from "./Button";
import { PageHead } from "./ui";

/**
 * What an authenticated page renders when there is no business to render it
 * for — the one place that decision is made.
 *
 * Thirteen pages used to answer this with `if (!selected) return null`, which
 * paints an empty page: no heading, no explanation, no way forward, and
 * nothing to distinguish "you haven't set up a business yet" from "the app is
 * broken". The Dashboard already had a proper state here because that blank
 * screen was reported as a bug; this is that state, lifted out so every page
 * gets it instead of only the one someone complained about.
 *
 * It covers BOTH reasons there is no selected business:
 *
 *   - the load succeeded and the owner genuinely has none yet — resume setup,
 *     which is the only useful thing to offer;
 *   - the load FAILED — say so and offer a retry. Never the setup invitation,
 *     which would tell an owner with three businesses to create a fourth.
 *
 * Copy defaults to the Dashboard's wording so the state reads identically
 * wherever it lands; a page with a more specific promise to make can override
 * the heading.
 */
export function NoBusinessProfile({
  title = "Welcome to FinSight",
  subtitle = "One short step and your dashboard comes to life.",
  children,
}: {
  title?: string;
  subtitle?: string;
  /** Replaces the default body copy of the setup invitation. */
  children?: ReactNode;
}) {
  const { error, refresh } = useBusinessProfiles();
  const [retrying, setRetrying] = useState(false);

  if (error) {
    return (
      <div>
        <PageHead title="We couldn't load your businesses" subtitle="Nothing has been lost." />
        <EmptyState
          icon="!"
          title="Your businesses didn't load"
          action={
            <Button
              type="button"
              disabled={retrying}
              onClick={() => {
                setRetrying(true);
                // The message on screen is already `error`; this catch only
                // keeps a second failure from surfacing as an unhandled
                // rejection, since the owner can simply press it again.
                void refresh()
                  .catch(() => undefined)
                  .finally(() => setRetrying(false));
              }}
            >
              {retrying ? "Trying again…" : "Try again"}
            </Button>
          }
        >
          {error} Your records and figures are untouched — this is only the list
          of businesses failing to arrive.
        </EmptyState>
      </div>
    );
  }

  return (
    <div>
      <PageHead title={title} subtitle={subtitle} />
      <EmptyState
        image="/mascot/01-onboarding/businessprofilesetup.webp"
        title="Finish setting up your business"
        action={
          <ButtonLink to="/onboarding" variant="primary">
            Continue setup
          </ButtonLink>
        }
      >
        {children ?? (
          <>
            FinSight needs your business name and a few figures before it can work out your sales
            target, track your recovery or flag large expenses. Anything you already typed was kept.
          </>
        )}
      </EmptyState>
    </div>
  );
}
