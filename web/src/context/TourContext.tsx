import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { useAuth } from "./AuthContext";
import { useBusinessProfiles } from "./BusinessProfileContext";
import { preferencePatch, readTour, reconcile, writeTour, type StoredTour } from "../lib/tourStorage";
import { TOUR_STEPS } from "../components/tour/steps";
import { TourOverlay } from "../components/tour/TourOverlay";

/**
 * The product tour's one owner.
 *
 * Mounted once inside AuthenticatedLayout, wrapping AppShell — which is what
 * makes a duplicate tour instance impossible and lets the shell read
 * `activeStepId` to hold its Quick-add menu open for the two steps that
 * highlight items inside it.
 *
 * WHEN THE TOUR AUTO-STARTS — all of these, none negotiable:
 *   - a signed-in user whose stored status is neither completed nor skipped
 *     (the account's own tourStatus, cached in localStorage per user id; see
 *     lib/tourStorage.ts for how the two are reconciled),
 *   - that account's preferences having arrived and been reconciled, so a
 *     tour finished on another device is never re-offered here while
 *     /auth/me is still in flight,
 *   - a selected business profile. An owner who skipped Business Profile
 *     Setup has an app whose nav, quick-add, bell and dashboard all render
 *     nothing — touring an empty shell teaches nothing, so the tour waits
 *     until their first profile exists. Their status stays not_started, so
 *     it offers itself then.
 *   - the dashboard route, with its data actually loaded — detected by the
 *     `[data-tour="dashboard-loaded"]` marker Dashboard renders once its
 *     fetch settles. Polled briefly; if the dashboard never loads (API
 *     down), the poll gives up silently and the app is NOT blocked.
 *
 * A tour interrupted mid-way (navigation, reload, closed laptop) is stored
 * as in_progress with its step, and resumes from that step on the next
 * dashboard visit. Completed/skipped are terminal until "Restart product
 * tour" in the account menu writes it back to step 0.
 */

export interface TourContextValue {
  /** id of the active step, or null — the shell reads this. */
  activeStepId: string | null;
  active: boolean;
  stepIndex: number;
  setStepIndex: (i: number) => void;
  /** Ends the tour and records why. */
  stop: (status: "completed" | "skipped") => void;
  /** Rewinds to step 0 and (re)arms auto-start — the account-menu entry. */
  restart: () => void;
  /** Replay on every sign-in, regardless of a completed/skipped status. */
  alwaysShow: boolean;
  /**
   * Rejects if the account could not be told, having already put the switch
   * back — so the settings screen can say so rather than showing a preference
   * that only this browser believes.
   */
  setAlwaysShow: (value: boolean) => Promise<void>;
}

/** Exported for tests/harnesses that drive the overlay with a hand-built value. */
export const TourContext = createContext<TourContextValue | null>(null);

/** Null-safe consumer for chrome that may render without the provider (tests). */
export function useTourOptional() {
  return useContext(TourContext);
}

export function TourProvider({ children }: { children: ReactNode }) {
  const { profile, preferences, preferencesLoaded, updatePreferences } = useAuth();
  const { selected, loading } = useBusinessProfiles();
  const location = useLocation();

  const [active, setActive] = useState(false);
  const [stepIndex, setStepIndex] = useState(0);
  /*
   * Mirrored into state so the settings toggle re-renders from the same
   * source the gate reads. Seeded per user, because the stored value is
   * per user — a shared computer must not carry one owner's demo setting
   * into the next owner's session.
   */
  const [alwaysShow, setAlwaysShowState] = useState(false);

  /*
   * True once this account's server-side tour state has been read and either
   * adopted or migrated up. The auto-start gate waits for it: the cache alone
   * cannot tell "never toured" from "toured on the other laptop", and opening
   * the tour over a dashboard someone already toured is the exact failure this
   * whole move to the server was for.
   */
  const [reconciled, setReconciled] = useState(false);

  const userId = profile?.id;
  const onDashboard = location.pathname === "/dashboard";

  /** Cache locally AND tell the account. One writer, so the two cannot drift. */
  const persist = useCallback(
    (next: StoredTour) => {
      if (userId == null) return;
      writeTour(userId, next);
      // Fire and forget: the cache has already answered, and a tour must not
      // stall or error out because a preference write did. The next reconcile
      // (or the next advance) sends it again.
      void updatePreferences(preferencePatch(next)).catch(() => undefined);
    },
    [userId, updatePreferences],
  );

  // Whose state has been reconciled. Keyed by user id rather than a bare
  // boolean so switching accounts on a shared machine reconciles again
  // instead of trusting the previous owner's answer.
  const reconciledFor = useRef<number | null>(null);

  // Seed from the cache the moment the user is known — before /auth/me has
  // answered — so the settings switch renders the right way round rather than
  // flicking on a beat later.
  useEffect(() => {
    reconciledFor.current = null;
    setReconciled(false);
    setAlwaysShowState(userId == null ? false : readTour(userId).alwaysShow === true);
  }, [userId]);

  // Then reconcile against the account, exactly once per sign-in.
  useEffect(() => {
    if (userId == null || !preferencesLoaded || reconciledFor.current === userId) return;
    reconciledFor.current = userId;
    const { tour, push } = reconcile(readTour(userId), preferences);
    writeTour(userId, tour);
    setAlwaysShowState(tour.alwaysShow === true);
    // The migrate-up: local progress the server has never heard about goes up
    // as-is, rather than a server default coming down over it.
    if (push) void updatePreferences(push).catch(() => undefined);
    setReconciled(true);
  }, [userId, preferencesLoaded, preferences, updatePreferences]);

  /*
   * The one tour write that is NOT fire-and-forget. Progress can afford to be
   * (the cache answers, and the next advance sends it again), but this is a
   * preference the owner deliberately set: leaving the switch on after the
   * write failed would promise a replay that will not happen on their next
   * device. So it is optimistic here and rolled back — cache included — if the
   * account refuses it.
   */
  async function setAlwaysShow(value: boolean) {
    if (userId == null) {
      setAlwaysShowState(value);
      return;
    }
    const previous = readTour(userId);
    const next = { ...previous, alwaysShow: value };
    setAlwaysShowState(value);
    writeTour(userId, next);
    try {
      await updatePreferences(preferencePatch(next));
    } catch (err) {
      setAlwaysShowState(previous.alwaysShow === true);
      writeTour(userId, previous);
      throw err;
    }
  }

  // Persist progress on every change while active, so any interruption —
  // reload, crash, navigation — resumes from the right step. `alwaysShow`
  // rides along on every write below: it is a preference, not progress, and
  // finishing or skipping the tour must never turn it off behind the owner.
  useEffect(() => {
    if (active && userId != null) persist({ status: "in_progress", step: stepIndex, alwaysShow });
  }, [active, stepIndex, userId, alwaysShow, persist]);

  // Leaving the dashboard pauses the tour (status stays in_progress). The
  // targets live on that page and its chrome; a tooltip pointing at nothing
  // on another route would be worse than quietly waiting to resume.
  useEffect(() => {
    if (active && !onDashboard) setActive(false);
  }, [active, onDashboard]);

  // Auto-start / resume. Polls for the dashboard-loaded marker rather than
  // coupling to Dashboard's internals; gives up after ~20s without blocking
  // anything.
  useEffect(() => {
    if (active || !onDashboard || userId == null || loading || !selected || !reconciled) return;
    const stored = readTour(userId);
    // `alwaysShow` is the deliberate override: it exists so the tour can be
    // demonstrated and re-checked without registering a new account, which is
    // otherwise the only way past a terminal status.
    if (!stored.alwaysShow && (stored.status === "completed" || stored.status === "skipped")) return;

    let tries = 0;
    const timer = window.setInterval(() => {
      if (!document.querySelector('[data-tour="dashboard-loaded"]')) {
        if (++tries > 50) window.clearInterval(timer);
        return;
      }
      window.clearInterval(timer);
      setStepIndex(
        stored.status === "in_progress"
          ? Math.min(stored.step ?? 0, TOUR_STEPS.length - 1)
          : 0,
      );
      setActive(true);
    }, 400);
    return () => window.clearInterval(timer);
  }, [active, onDashboard, userId, loading, selected, reconciled]);

  function stop(status: "completed" | "skipped") {
    if (userId != null) persist({ status, step: stepIndex, alwaysShow });
    setActive(false);
  }

  function restart() {
    if (userId != null) persist({ status: "in_progress", step: 0, alwaysShow });
    setStepIndex(0);
    // On the dashboard the auto-start effect would race the loaded marker;
    // activate directly when it is already there. Elsewhere the caller
    // navigates to /dashboard and the effect takes over.
    if (onDashboard && document.querySelector('[data-tour="dashboard-loaded"]')) {
      setActive(true);
    } else {
      setActive(false);
    }
  }

  const value: TourContextValue = {
    activeStepId: active ? (TOUR_STEPS[stepIndex]?.id ?? null) : null,
    active,
    stepIndex,
    setStepIndex,
    stop,
    restart,
    alwaysShow,
    setAlwaysShow,
  };

  return (
    <TourContext.Provider value={value}>
      {children}
      {active ? <TourOverlay /> : null}
    </TourContext.Provider>
  );
}
