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
  const { profiles, loading } = useBusinessProfiles();
  const location = useLocation();

  if (loading) return null;

  if (profiles.length === 0 && user) {
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
