import { Link, useLocation } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { ButtonLink } from "../components/Button";

/**
 * The catch-all for a path no route matches.
 *
 * WHY THIS EXISTS AT ALL. `<Routes>` renders `null` when nothing matches — not
 * an error, not a fallback, nothing — so an unmatched path produced a silent
 * blank white page with no chrome, no message and no console output. That is
 * indistinguishable from a crashed bundle, and it cost a real debugging session
 * to tell the two apart: a dev server holding a stale App.tsx had dropped a
 * route, and the only symptom available was "the page is blank".
 *
 * A 404 that names the path turns that whole class of problem into something
 * that reads itself. Any future route that fails to register, any mistyped
 * link, any bookmark to a path that has since moved now says so.
 *
 * DELIBERATELY OUTSIDE AuthenticatedLayout. A wrong URL is not a reason to
 * demand a login, and wrapping this in ProtectedRoute would bounce a signed-out
 * visitor to /login — which tells them their URL was wrong by showing them a
 * form, the least informative answer available. It renders its own centred
 * chrome instead, the way the auth screens do.
 *
 * The onward link is chosen from the session, because "go home" means different
 * places to different people: an owner mid-session wants their dashboard, and a
 * visitor wants the landing page they were probably looking for.
 */
export function NotFound() {
  const { profile } = useAuth();
  const location = useLocation();

  return (
    <div
      // No AppShell: this route sits outside the authenticated layout, so it
      // paints its own page background rather than inheriting one.
      className="relative flex min-h-screen flex-col items-center justify-center bg-paper-50 px-4 py-6 text-center sm:px-6"
    >
      <span className="flex items-center gap-2.5">
        <span
          aria-hidden
          className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-700 font-display text-sm font-extrabold text-white"
        >
          F
        </span>
        <span className="font-display text-lg font-extrabold tracking-[-0.02em] text-ink-900">
          Fin<span className="text-brand-700">Sight</span>
        </span>
      </span>

      <h1 className="mt-8 font-display text-2xl font-bold tracking-tight text-ink-900">
        This page doesn't exist
      </h1>
      <p className="mt-2 max-w-md text-sm leading-relaxed text-ink-500">
        Nothing in FinSight matches this address. It may have moved, or the link
        that brought you here may be out of date.
      </p>

      {/*
        The path itself, verbatim. It is the one piece of information that makes
        this page actionable rather than decorative — it is what someone reports
        when a link is broken, and what tells a developer at a glance whether a
        route is missing or a URL is mistyped. `break-all` because a long path
        must not push the card wider than the viewport.
      */}
      <code className="mt-4 max-w-full break-all rounded-lg border border-paper-200 bg-paper px-3 py-2 text-xs text-ink-600">
        {location.pathname}
      </code>

      <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
        <ButtonLink to={profile ? "/dashboard" : "/"}>
          {profile ? "Go to dashboard" : "Go to home"}
        </ButtonLink>
        {profile ? (
          <Link
            to="/records"
            className="tap-inline text-sm font-medium text-brand-700 hover:text-brand-800"
          >
            View records
          </Link>
        ) : (
          <Link
            to="/login"
            className="tap-inline text-sm font-medium text-brand-700 hover:text-brand-800"
          >
            Log in
          </Link>
        )}
      </div>
    </div>
  );
}
