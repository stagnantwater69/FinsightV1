import { Link } from "react-router-dom";
import { useBusinessProfiles } from "../context/BusinessProfileContext";

/**
 * The one line that follows an owner who chose "Skip for now".
 *
 * WHY IT EXISTS AT ALL. Skipping the wizard used to hand back an app whose
 * every door showed the same "Finish setting up your business" card, so the
 * skip skipped to nothing. The pages that only READ are open now and sit in
 * their own empty states instead — which means the invitation to finish setup
 * no longer has a page of its own to live on. It lives here: rendered once in
 * the shell, above whatever route is on screen.
 *
 * NOT DISMISSIBLE, and deliberately. They already dismissed the wizard; this
 * is the single action that turns the empty app into a working one, so there
 * is nothing left to fall back to if it can be dismissed too. The price of
 * that is it has to stay calm — one line, neutral tint, no alert colour and no
 * card — because an owner will be looking at it on every page until they act.
 *
 * `profiles.length === 0 && !error` is the same test RequireBusinessProfile
 * makes, for the same reason: an empty list only means "no business yet" when
 * the load SUCCEEDED. A failed fetch leaves the same empty array, and telling
 * an owner with three businesses to go and set one up is exactly the bug that
 * check exists to prevent. `loading` keeps the bar from flashing in and out on
 * every route change before the list arrives.
 */
export function SetupPrompt() {
  const { profiles, loading, error } = useBusinessProfiles();

  if (loading || error || profiles.length > 0) return null;

  return (
    <div className="mb-5 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl bg-paper-100 px-3.5 py-2.5 text-sm text-ink-600 ring-1 ring-paper-200">
      <p className="min-w-0">Your dashboard is empty until you add a business.</p>
      <Link
        to="/onboarding"
        className="tap-inline font-semibold text-brand-700 underline underline-offset-2 hover:text-brand-800"
      >
        Finish setup
      </Link>
    </div>
  );
}
