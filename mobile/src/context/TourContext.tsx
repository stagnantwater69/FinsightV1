import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { View } from "react-native";
import { useFocusEffect } from "@react-navigation/native";
import { useAuth } from "./AuthContext";
import { useBusinessProfiles } from "./BusinessProfileContext";
import {
  readTour,
  saveAlwaysShowTour,
  saveTourProgress,
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
 * from the Restart row in More whenever the owner asks.
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
  const { profile } = useAuth();
  const { selected, loading: profilesLoading } = useBusinessProfiles();

  /** null while the keystore read is in flight — see the note above. */
  const [stored, setStored] = useState<StoredTour | null>(null);
  const [active, setActive] = useState(false);
  const [stepIndex, setStepIndex] = useState(0);
  const [home, setHome] = useState<HomeStage>({ onHomeTab: false, dashboardLoaded: false });

  const userId = profile?.id;
  const startedRef = useRef(false);

  // Read the stored record for whoever is signed in. Re-reading on a change of
  // user is what keeps a shared phone honest, and clearing `startedRef` there
  // is what makes "always show on login" mean per-login rather than per-install.
  useEffect(() => {
    let live = true;
    startedRef.current = false;
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

  // Persist progress on every change while a run is live, so an interruption
  // resumes from the right step rather than from the beginning.
  useEffect(() => {
    if (!active || userId == null) return;
    void saveTourProgress(userId, "in_progress", stepIndex);
  }, [active, stepIndex, userId]);

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
      alwaysShow: stored.alwaysShow === true,
      hasProfile: !!selected,
      dashboardLoaded: home.dashboardLoaded,
      onHomeTab: home.onHomeTab,
    });
    if (!open) return;

    startedRef.current = true;
    setStepIndex(resumeStepIndex(stored.status, stored.step, TOUR_STEPS.length));
    setActive(true);
  }, [active, userId, stored, profilesLoading, selected, home.dashboardLoaded, home.onHomeTab]);

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
      setStored((prev) => ({ ...(prev ?? { status }), status, step: stepIndex }));
      if (userId != null) void saveTourProgress(userId, status, stepIndex);
    },
    [stepIndex, userId],
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
    setStored((prev) => ({ ...(prev ?? { status: "in_progress" }), status: "in_progress", step: 0 }));
    if (userId != null) void saveTourProgress(userId, "in_progress", 0);
  }, [userId]);

  const setAlwaysShow = useCallback(
    (value: boolean) => {
      setStored((prev) => ({
        ...(prev ?? { status: "not_started" }),
        alwaysShow: value ? true : undefined,
      }));
      if (userId != null) void saveAlwaysShowTour(userId, value);
    },
    [userId],
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
