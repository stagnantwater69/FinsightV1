import { Navigate, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { useBusinessProfiles } from "../context/BusinessProfileContext";
import { readOnboarding } from "../lib/onboardingDraft";

/**
 * Sends an owner who has no business yet into the setup wizard.
 *
 * WHY `profiles.length === 0` IS THE WHOLE TEST. It is the same fact the app
 * already depends on everywhere else — no business means no records, no
 * targets and nothing to show — so it needs no flag of its own, and it can
 * never catch an established owner: having a profile is exactly what completing
 * setup means. See lib/onboardingDraft.ts.
 *
 * A FAILED LOAD IS NOT AN EMPTY LIST. The redirect requires `error === null`,
 * so a dropped request leaves an established owner on the page they asked for
 * with a retry, rather than in a wizard telling them to create the business
 * they already have.
 *
 * DISMISSAL IS RESPECTED. Someone who chose "Skip for now" is not redirected
 * again; they get on with whatever they came to do and pick setup back up from
 * the prompt on the dashboard. Redirecting them anyway would make Skip a lie,
 * and a skip button that does not skip is worse than none.
 *
 * Nothing renders until the profile list has loaded. The alternative is a
 * flash of the dashboard followed by a redirect, which reads as a glitch.
 */
export function RequireBusinessProfile() {
  const { profile: user } = useAuth();
  const { profiles, loading, error } = useBusinessProfiles();
  const location = useLocation();

  if (loading) return null;

  // An empty list only means "no business yet" when the load SUCCEEDED. A
  // failed fetch leaves the same empty array behind, and treating that as
  // proof of a new account marched established owners into the setup wizard
  // every time the connection dropped. They stay where they are instead, and
  // the page they asked for offers a retry (see NoBusinessProfile).
  if (profiles.length === 0 && !error && user) {
    const { dismissed } = readOnboarding(user.id);
    // The wizard's own CSV step lives under /records, and step 3 runs after the
    // profile exists — so this cannot loop. The path check is belt and braces
    // for a hand-typed URL during a dismissed setup.
    if (!dismissed && location.pathname !== "/onboarding") {
      return <Navigate to="/onboarding" replace />;
    }
  }

  return <Outlet />;
}
