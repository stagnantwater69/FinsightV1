import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { View } from "react-native";
import { useFocusEffect } from "@react-navigation/native";
import { useAuth } from "./AuthContext";
import { useBusinessProfiles } from "./BusinessProfileContext";
import {
  preferencePatch,
  readTour,
  reconcile,
  writeTour,
  type StoredTour,
} from "../lib/tourStorage";
import { resumeStepIndex, shouldStartTour } from "../lib/tourGating";
import { nextStepIndex, previousStepIndex, TOUR_STEPS } from "../components/tour/steps";
import { stepIsOnScreen } from "../components/tour/targets";
import { TourOverlay } from "../components/tour/TourOverlay";
import {
  TourContext,
  useTourOptional,
  type TourContextValue,
  type TourHomeStage as HomeStage,
} from "./tourContextValue";

/*
 * Re-exported so the several screens that read the tour keep importing it from
 * the provider they think of it as belonging to. The context object itself
 * lives in tourContextValue.ts to keep this file and TourOverlay off each
 * other's import path — see the note there.
 */
export { useTourOptional };

/**
 * The product tour's one owner.
 *
 * Mounted once, around the authenticated tab navigator (App.tsx), which is
 * what makes a second tour instance impossible and puts the provider below
 * both AuthProvider and BusinessProfileProvider — the two facts the start gate
 * is made of.
 *
 * WHEN THE TOUR OPENS is not decided here; it is decided by
 * `shouldStartTour` in lib/tourGating.ts, which is a pure function precisely
 * so it can be tested without a render harness. This file supplies its inputs:
 * the stored status (keystore, keyed by user id), whether a business profile
 * is selected, and whether Home is focused with its summary actually loaded —
 * reported by DashboardScreen through `useTourHomeStage`.
 *
 * WHY HOME REPORTS RATHER THAN THE PROVIDER POLLING. Web polls the DOM for a
 * `dashboard-loaded` marker because it has a DOM to poll. React Native has no
 * such thing, and "the tab is focused" is not the same question as "the
 * figures have arrived" — starting between the two would spotlight a skeleton.
 * One line in the screen that owns the fetch answers both honestly.
 *
 * ONCE PER SIGN-IN. `startedRef` latches when a run opens and only clears when
 * the signed-in user changes. Without it, `alwaysShow` — which deliberately
 * overrides a completed status — would reopen the tour the instant it was
 * finished, forever. "Always show on login" means exactly that: on login, and
 * from the Restart row in Settings whenever the owner asks.
 *
 * THE STORED VALUE IS ASYNC (SecureStore, unlike web's localStorage), so
 * `stored === null` means "still reading" and no decision is made at all until
 * it lands. Guessing "never seen it" for those few milliseconds would throw
 * the tour over the dashboard of someone who finished it weeks ago.
 *
 * A run interrupted by anything — leaving Home, locking the phone — stays
 * `in_progress` with its step and resumes there. completed and skipped are
 * terminal until Restart, or until "Always show the tour on login" is on.
 */

export function TourProvider({ children }: { children: ReactNode }) {
  const { profile, preferences, preferencesLoaded, updatePreferences } = useAuth();
  const { selected, loading: profilesLoading } = useBusinessProfiles();

  /** null while the keystore read is in flight — see the note above. */
  const [stored, setStored] = useState<StoredTour | null>(null);
  const [active, setActive] = useState(false);
  const [stepIndex, setStepIndex] = useState(0);
  const [home, setHome] = useState<HomeStage>({ onHomeTab: false, dashboardLoaded: false });

  const userId = profile?.id;
  const startedRef = useRef(false);

  /*
   * True once this account's server-side tour state has been read and either
   * adopted or migrated up. The start gate waits for it — see `reconciled` in
   * lib/tourGating.ts for why the cache alone is not enough to decide on.
   */
  const [reconciled, setReconciled] = useState(false);
  /*
   * Whose state has been reconciled, keyed by user id rather than a bare
   * boolean: a phone handed to the next person behind the counter must
   * reconcile again instead of trusting the previous owner's answer.
   */
  const reconciledFor = useRef<number | null>(null);

  /** Cache locally AND tell the account. One writer, so the two cannot drift. */
  const persist = useCallback(
    (next: StoredTour) => {
      if (userId == null) return;
      void writeTour(userId, next);
      // Fire and forget: the cache has already answered, and a running tour
      // must not stall or error out because a preference write did. The next
      // advance — or the next sign-in's reconcile — sends it again.
      void updatePreferences(preferencePatch(next)).catch(() => undefined);
    },
    [userId, updatePreferences],
  );

  // Read the stored record for whoever is signed in. Re-reading on a change of
  // user is what keeps a shared phone honest, and clearing `startedRef` there
  // is what makes "always show on login" mean per-login rather than per-install.
  useEffect(() => {
    let live = true;
    startedRef.current = false;
    reconciledFor.current = null;
    setReconciled(false);
    setActive(false);
    setStored(null);
    if (userId == null) return;
    void readTour(userId).then((value) => {
      if (live) setStored(value);
    });
    return () => {
      live = false;
    };
  }, [userId]);

  // Then reconcile the cache against the account, exactly once per sign-in.
  useEffect(() => {
    if (userId == null || stored === null || !preferencesLoaded) return;
    if (reconciledFor.current === userId) return;
    reconciledFor.current = userId;

    const { tour, push } = reconcile(stored, preferences);
    setStored(tour);
    void writeTour(userId, tour);
    // The migrate-up: progress this account's row has never heard about goes
    // up as it stands, rather than a server default coming down over the tour
    // someone finished before any of this was stored server-side.
    if (push) void updatePreferences(push).catch(() => undefined);
    setReconciled(true);
  }, [userId, stored, preferencesLoaded, preferences, updatePreferences]);

  // Persist progress on every change while a run is live, so an interruption
  // resumes from the right step rather than from the beginning.
  useEffect(() => {
    if (!active || userId == null) return;
    persist({ status: "in_progress", step: stepIndex, alwaysShow: stored?.alwaysShow === true });
    // `stored` is deliberately not a dependency: it changes on every write
    // this effect makes, and re-running on its own output would be a loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, stepIndex, userId, persist]);

  // Leaving Home pauses the run. Its targets live on that screen and in the
  // tab bar; a card describing the dashboard on top of the records list would
  // be worse than quietly waiting to resume.
  useEffect(() => {
    if (active && !home.onHomeTab) setActive(false);
  }, [active, home.onHomeTab]);

  // Start / resume.
  useEffect(() => {
    if (active || startedRef.current) return;
    if (userId == null || stored === null || profilesLoading) return;

    const open = shouldStartTour({
      status: stored.status,
      reconciled,
      alwaysShow: stored.alwaysShow === true,
      hasProfile: !!selected,
      dashboardLoaded: home.dashboardLoaded,
      onHomeTab: home.onHomeTab,
    });
    if (!open) return;

    startedRef.current = true;
    setStepIndex(resumeStepIndex(stored.status, stored.step, TOUR_STEPS.length));
    setActive(true);
  }, [active, userId, stored, reconciled, profilesLoading, selected, home.dashboardLoaded, home.onHomeTab]);

  const reportHomeStage = useCallback((stage: HomeStage) => {
    setHome((prev) =>
      prev.onHomeTab === stage.onHomeTab && prev.dashboardLoaded === stage.dashboardLoaded
        ? prev
        : stage,
    );
  }, []);

  const stop = useCallback(
    (status: "completed" | "skipped") => {
      setActive(false);
      const next: StoredTour = { ...(stored ?? { status }), status, step: stepIndex };
      setStored(next);
      persist(next);
    },
    [stepIndex, stored, persist],
  );

  const next = useCallback(() => {
    const target = nextStepIndex(TOUR_STEPS, stepIndex, stepIsOnScreen);
    if (target === null) stop("completed");
    else setStepIndex(target);
  }, [stepIndex, stop]);

  const back = useCallback(() => {
    const target = previousStepIndex(TOUR_STEPS, stepIndex, stepIsOnScreen);
    if (target !== null) setStepIndex(target);
  }, [stepIndex]);

  const restart = useCallback(() => {
    // Re-arm rather than activate: the caller navigates to Home, and the start
    // gate above opens the tour once Home is focused with its figures in. On
    // Home already, that is the same tick.
    startedRef.current = false;
    setStepIndex(0);
    setActive(false);
    const next: StoredTour = { ...(stored ?? { status: "in_progress" }), status: "in_progress", step: 0 };
    setStored(next);
    persist(next);
  }, [stored, persist]);

  /*
   * The one tour write that is NOT fire-and-forget.
   *
   * Progress can afford to be — the cache answers, and the next advance sends
   * it again — but this is a preference the owner deliberately set. Leaving
   * the switch on after the write failed would promise a replay that will not
   * happen on their next device, so it is optimistic here and rolled back,
   * cache included, if the account refuses it. The rejection is what lets
   * Settings say so.
   */
  const setAlwaysShow = useCallback(
    async (value: boolean) => {
      const previous: StoredTour = stored ?? { status: "not_started" };
      const next: StoredTour = { ...previous, alwaysShow: value ? true : undefined };
      setStored(next);
      if (userId == null) return;
      await writeTour(userId, next);
      try {
        await updatePreferences(preferencePatch(next));
      } catch (err) {
        setStored(previous);
        await writeTour(userId, previous);
        throw err;
      }
    },
    [stored, userId, updatePreferences],
  );

  const value: TourContextValue = {
    active,
    stepIndex,
    activeStepId: active ? (TOUR_STEPS[stepIndex]?.id ?? null) : null,
    next,
    back,
    stop,
    restart,
    alwaysShow: stored?.alwaysShow === true,
    setAlwaysShow,
    reportHomeStage,
  };

  /*
   * The wrapping View is what the overlay is absolutely positioned against.
   * The overlay used to be a Modal — a separate native window, whose origin
   * differs from the app's by a status bar on Android, which is why every
   * spotlight was drawn above the control it described. In the app's own tree
   * it shares one coordinate space with everything it points at.
   */
  return (
    <TourContext.Provider value={value}>
      <View style={{ flex: 1 }}>
        {/*
          While a step is up the app underneath is hidden from screen readers,
          which is the half of "modal" that the overlay cannot get back by
          drawing over things: TalkBack would otherwise walk straight past the
          card into the dimmed dashboard behind it. `accessibilityElementsHidden`
          is the iOS half, `importantForAccessibility` the Android one.
        */}
        <View
          style={{ flex: 1 }}
          accessibilityElementsHidden={active}
          importantForAccessibility={active ? "no-hide-descendants" : "auto"}
        >
          {children}
        </View>
        {active ? <TourOverlay /> : null}
      </View>
    </TourContext.Provider>
  );
}

/**
 * Home's one line of tour wiring: "I am the visible tab, and my figures are
 * in". Both halves matter — focus alone would start the tour over a skeleton.
 */
export function useTourHomeStage(dashboardLoaded: boolean) {
  const report = useTourOptional()?.reportHomeStage;

  useFocusEffect(
    useCallback(() => {
      report?.({ onHomeTab: true, dashboardLoaded });
      return () => report?.({ onHomeTab: false, dashboardLoaded: false });
    }, [report, dashboardLoaded]),
  );
}
