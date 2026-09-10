import { useEffect, useState } from "react";

/**
 * Whether the owner has asked their OS/browser to reduce motion.
 *
 * Mobile's per-component check (lib/useReducedMotion.ts) exists because
 * React Native's `Animated` API ignores the platform setting entirely.
 * Web's global CSS rule in index.css already does that job for CSS
 * animations (the `animate-breathe` class this replaces), but a
 * `setInterval`-driven frame sequence isn't a CSS animation — nothing stops
 * it from ticking under `prefers-reduced-motion: reduce`, so the flipbook
 * needs this same per-component gate mobile uses.
 */
function supportsMatchMedia(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function";
}

export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => supportsMatchMedia() && window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );

  useEffect(() => {
    if (!supportsMatchMedia()) return;

    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = (event: MediaQueryListEvent) => setReduced(event.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  return reduced;
}
