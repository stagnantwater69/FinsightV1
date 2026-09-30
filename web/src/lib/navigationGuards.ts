import { useCallback, useContext, useEffect, useRef, type MutableRefObject } from "react";
import { UNSAFE_NavigationContext, useLocation, useNavigate } from "react-router-dom";

const DEFAULT_MESSAGE = "Leave this receipt review? Your unsaved changes will be lost.";
export const BEFORE_BUSINESS_PROFILE_SWITCH =
  "finsight:before-business-profile-switch";

interface ActiveHistoryGuard {
  shouldWarn: () => boolean;
  approve: () => void;
  message: string;
  currentIndex: MutableRefObject<number | null>;
  ignoreNextPop: MutableRefObject<boolean>;
}

let activeHistoryGuard: ActiveHistoryGuard | null = null;
let popstateHandlerInstalled = false;

/** Must run before BrowserRouter registers its listener, so a cancelled POP never unmounts the form. */
export function installNavigationGuardPopstateHandler() {
  if (popstateHandlerInstalled || typeof window === "undefined") return;
  popstateHandlerInstalled = true;
  window.addEventListener("popstate", (event) => {
    const guard = activeHistoryGuard;
    if (!guard) return;

    const nextIndex = typeof event.state?.idx === "number" ? event.state.idx : null;
    if (guard.ignoreNextPop.current) {
      guard.ignoreNextPop.current = false;
      if (nextIndex !== null) guard.currentIndex.current = nextIndex;
      return;
    }
    if (!guard.shouldWarn()) return;
    if (window.confirm(guard.message)) {
      guard.approve();
      if (nextIndex !== null) guard.currentIndex.current = nextIndex;
      return;
    }

    event.stopImmediatePropagation();
    guard.ignoreNextPop.current = true;
    const delta = guard.currentIndex.current !== null && nextIndex !== null
      ? guard.currentIndex.current - nextIndex
      : 1;
    window.history.go(delta || 1);
  }, true);
}

/** Guards user-driven route changes while keeping programmatic success navigation explicit. */
export function useUnsavedChangesWarning(when: boolean, message = DEFAULT_MESSAGE) {
  const navigate = useNavigate();
  const location = useLocation();
  const { navigator } = useContext(UNSAFE_NavigationContext);
  const whenRef = useRef(when);
  const allowRef = useRef(false);
  const ignoreNextPopRef = useRef(false);
  const historyIndexRef = useRef<number | null>(
    typeof window.history.state?.idx === "number" ? window.history.state.idx : null,
  );

  whenRef.current = when;

  useEffect(() => {
    if (!when) allowRef.current = false;
  }, [when]);

  useEffect(() => {
    if (typeof window.history.state?.idx === "number") {
      historyIndexRef.current = window.history.state.idx;
    }
  }, [location.key]);

  useEffect(() => {
    installNavigationGuardPopstateHandler();
    const registration: ActiveHistoryGuard = {
      shouldWarn: () => whenRef.current && !allowRef.current,
      approve: () => { allowRef.current = true; },
      message,
      currentIndex: historyIndexRef,
      ignoreNextPop: ignoreNextPopRef,
    };
    activeHistoryGuard = registration;
    return () => {
      if (activeHistoryGuard === registration) activeHistoryGuard = null;
    };
  }, [message]);

  useEffect(() => {
    const originalPush = navigator.push;
    const originalReplace = navigator.replace;

    function approved() {
      if (!whenRef.current || allowRef.current) return true;
      if (!window.confirm(message)) return false;
      allowRef.current = true;
      return true;
    }

    const guardedPush: typeof navigator.push = (...args) => {
      if (approved()) originalPush(...args);
    };
    const guardedReplace: typeof navigator.replace = (...args) => {
      if (approved()) originalReplace(...args);
    };

    navigator.push = guardedPush;
    navigator.replace = guardedReplace;
    return () => {
      if (navigator.push === guardedPush) navigator.push = originalPush;
      if (navigator.replace === guardedReplace) navigator.replace = originalReplace;
    };
  }, [message, navigator]);

  useEffect(() => {
    function shouldWarn() {
      return whenRef.current && !allowRef.current;
    }

    function onBeforeUnload(event: BeforeUnloadEvent) {
      if (!shouldWarn()) return;
      event.preventDefault();
      event.returnValue = "";
    }

    function onDocumentClick(event: MouseEvent) {
      if (!shouldWarn() || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
        return;
      }
      const target = event.target;
      const anchor = target instanceof Element ? target.closest<HTMLAnchorElement>("a[href]") : null;
      if (!anchor || anchor.target === "_blank" || anchor.hasAttribute("download")) return;

      const destination = new URL(anchor.href, window.location.href);
      if (destination.origin !== window.location.origin) return;
      if (destination.pathname === location.pathname && destination.search === location.search) return;

      event.preventDefault();
      event.stopPropagation();
      if (!window.confirm(message)) return;

      allowRef.current = true;
      navigate(`${destination.pathname}${destination.search}${destination.hash}`);
    }

    function onBusinessProfileSwitch(event: Event) {
      if (!shouldWarn()) return;
      if (!window.confirm(message)) {
        event.preventDefault();
        return;
      }
      allowRef.current = true;
    }

    window.addEventListener("beforeunload", onBeforeUnload);
    window.addEventListener(
      BEFORE_BUSINESS_PROFILE_SWITCH,
      onBusinessProfileSwitch,
    );
    document.addEventListener("click", onDocumentClick, true);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      window.removeEventListener(
        BEFORE_BUSINESS_PROFILE_SWITCH,
        onBusinessProfileSwitch,
      );
      document.removeEventListener("click", onDocumentClick, true);
    };
  }, [location.pathname, location.search, message, navigate]);

  return useCallback(() => {
    allowRef.current = true;
  }, []);
}
