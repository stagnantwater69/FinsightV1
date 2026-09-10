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
  /**
   * Whether there is anything worth touring yet.
   *
   * False for an owner who chose "Skip for now" and has no business. The
   * auto-start below has always honoured that; `restart` did not, and the two
   * entry points disagreeing is what made "Restart product tour" produce a
   * four-step stub of a ten-step tour. The controls that offer the tour read
   * this so they can say WHY it is unavailable rather than doing nothing.
   */
  available: boolean;
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

  /*
   * "This session has already had its answer" — the latch that makes a
   * dismissal stick.
   *
   * `alwaysShow` is the deliberate override that lets the tour be re-offered
   * past a terminal completed/skipped status. Without a latch that override
   * also defeated the dismissal itself: `stop()` set `active` to false, the
   * auto-start effect re-ran (it depends on `active`), found `alwaysShow`
   * true, and started the tour again — an owner with the preference on could
   * not get off the dashboard tour at all.
   *
   * So dismissal is remembered for the life of this mount. It is deliberately
   * NOT persisted: `alwaysShow` still means "offer it again on a later visit",
   * which is exactly what a fresh mount is. Only an explicit `restart()`
   * clears it sooner.
   *
   * Route changes do not touch it — leaving the dashboard pauses the tour and
   * coming back resumes it, as before.
   */
  const dismissedThisSession = useRef(false);

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
    // A different owner on the same machine has not dismissed anything.
    dismissedThisSession.current = false;
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
  const persistRef = useRef(persist);
  persistRef.current = persist;
  useEffect(() => {
    // Deliberately NOT depending on `persist`. What this effect is for is
    // "progress changed, write it down"; a callback that changed identity
    // would make it write on every render instead, and since the write sets
    // state upstream in AuthContext that is a loop rather than an extra
    // request. AuthContext keeps `updatePreferences` stable for the same
    // reason — this is the second lock on the same door.
    if (active && userId != null) {
      persistRef.current({ status: "in_progress", step: stepIndex, alwaysShow });
    }
  }, [active, stepIndex, userId, alwaysShow]);

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
    // Dismissed already on this visit — including when `alwaysShow` is on,
    // which is the whole point of the latch.
    if (dismissedThisSession.current) return;
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
    // Before the state change, so the auto-start effect sees the latch on the
    // very re-render `setActive(false)` triggers.
    dismissedThisSession.current = true;
    setActive(false);
  }

  function restart() {
    /*
     * THE SAME GATE THE AUTO-START MAKES, and it has to be here too.
     *
     * Six of the ten steps point at chrome that does not exist without a
     * business — the switcher, the dashboard summary, Quick add (which owns
     * both the receipt and CSV steps), and Ask FinSight. The overlay skips a
     * step whose target is missing rather than stranding the tour, which is
     * right on its own terms, and the two together turned the tour into four
     * disconnected cards that teach nothing.
     *
     * This was latent until the read-only pages became enterable: before that
     * the dashboard rendered the setup card instead of its `dashboard-loaded`
     * marker, so `restart` fell through to the else below and quietly did
     * nothing. Now the marker is there, so the guard has to be explicit.
     */
    if (!selected) return;
    if (userId != null) persist({ status: "in_progress", step: 0, alwaysShow });
    // Asking for the tour back is the one thing that clears the latch.
    dismissedThisSession.current = false;
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
    available: !!selected,
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
