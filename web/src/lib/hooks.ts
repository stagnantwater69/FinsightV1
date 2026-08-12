import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Closes a popover on outside click and on Escape, and returns focus to the
 * control that opened it.
 *
 * The focus return is the part that is easy to leave out and the part a
 * keyboard user actually needs: without it, dismissing a menu with Escape
 * drops focus onto <body>, and the next Tab restarts from the top of the
 * document rather than continuing from the button you were just on.
 *
 * Attach `ref` to the popover's wrapper (the element containing BOTH the
 * trigger and the panel) and `triggerRef` to the trigger itself.
 */
export function useDismiss<T extends HTMLElement = HTMLDivElement>(open: boolean, close: () => void) {
  const ref = useRef<T>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  // Tracks whether the close came from Escape, so a click elsewhere doesn't
  // yank focus back to a trigger the user has deliberately moved away from.
  const restoreFocus = useRef(false);

  useEffect(() => {
    if (!open) return;

    function onPointer(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        restoreFocus.current = false;
        close();
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        restoreFocus.current = true;
        close();
      }
    }

    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, close]);

  useEffect(() => {
    if (!open && restoreFocus.current) {
      restoreFocus.current = false;
      triggerRef.current?.focus();
    }
  }, [open]);

  return { ref, triggerRef };
}

/**
 * State that survives a reload, in localStorage.
 *
 * Used for the two shell preferences that would be irritating to re-set on
 * every visit — the sidebar's collapsed state and the table page size.
 * Storage failures (private browsing, quota) degrade to plain useState rather
 * than throwing.
 */
export function usePersistentState<T>(key: string, initial: T, isValid: (v: unknown) => v is T) {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      if (raw !== null) {
        const parsed = JSON.parse(raw) as unknown;
        if (isValid(parsed)) return parsed;
      }
    } catch {
      // fall through to the default
    }
    return initial;
  });

  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // Preference just won't persist this session.
    }
  }, [key, value]);

  return [value, setValue] as const;
}

/** Tracks a media query. Used to decide layout behaviour that CSS alone can't. */
export function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.matchMedia(query).matches;
  });

  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = (e: MediaQueryListEvent) => setMatches(e.matches);
    setMatches(mql.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);

  return matches;
}

/**
 * Debounces a rapidly-changing value.
 *
 * The global search fires on every keystroke; without this it would issue a
 * request per character and let slow responses land out of order.
 */
export function useDebounced<T>(value: T, delay = 220) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(id);
  }, [value, delay]);
  return debounced;
}

/**
 * Keeps Tab inside an open overlay.
 *
 * `useDismiss` handles outside-click and Escape, but neither stops Tab walking
 * out of a drawer and into the page behind it — where the user is now operating
 * controls they cannot see, with the overlay still open on top of them.
 *
 * Attach `ref` to the overlay's own element. On open it focuses the first
 * control inside; while open, Tab and Shift+Tab wrap at the ends.
 *
 * The `<dialog>` in ConfirmDialog gets all of this from the platform and must
 * NOT use this hook — this exists for the surfaces that cannot be a <dialog>,
 * like the AI drawer that has to leave the page behind it readable.
 */
export function useFocusTrap<T extends HTMLElement = HTMLDivElement>(open: boolean) {
  const ref = useRef<T>(null);

  useEffect(() => {
    if (!open) return;
    const node = ref.current;
    if (!node) return;

    const SELECTOR =
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

    // Queried fresh on each Tab rather than cached: the contents of these
    // overlays change while they are open (the AI drawer grows a message list),
    // and a stale list would trap focus on elements that no longer exist.
    const focusable = () =>
      Array.from(node.querySelectorAll<HTMLElement>(SELECTOR)).filter(
        (el) => el.offsetParent !== null || el === document.activeElement,
      );

    focusable()[0]?.focus();

    function onKey(e: KeyboardEvent) {
      if (e.key !== "Tab") return;
      const items = focusable();
      if (items.length === 0) return;

      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = document.activeElement;

      if (e.shiftKey && (active === first || !node!.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  return ref;
}

/**
 * Roving focus for a list of menu items, driven by ArrowUp / ArrowDown.
 *
 * Returns a keydown handler to put on the menu container. Home and End jump
 * to the ends, which is what a screen-reader user expects from a menu and
 * what browsers give you for free in a <select> but not in a div.
 */
export function useMenuKeys(itemSelector = "[role='menuitem']") {
  return useCallback(
    (e: React.KeyboardEvent<HTMLElement>) => {
      const keys = ["ArrowDown", "ArrowUp", "Home", "End"];
      if (!keys.includes(e.key)) return;

      const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>(itemSelector)).filter(
        (el) => !el.hasAttribute("disabled"),
      );
      if (items.length === 0) return;

      e.preventDefault();
      const current = items.indexOf(document.activeElement as HTMLElement);
      let next = current;

      if (e.key === "ArrowDown") next = current < 0 ? 0 : (current + 1) % items.length;
      else if (e.key === "ArrowUp") next = current < 0 ? items.length - 1 : (current - 1 + items.length) % items.length;
      else if (e.key === "Home") next = 0;
      else next = items.length - 1;

      items[next]?.focus();
    },
    [itemSelector],
  );
}
