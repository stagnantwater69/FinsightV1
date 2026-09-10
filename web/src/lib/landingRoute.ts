/**
 * What `/` should serve (QA register FUN-014).
 *
 * `/` is two things at once: the public marketing page, and the shortcut a
 * returning owner uses to get to their own numbers. The rule that resolves it
 * lives here rather than inline in App.tsx so it can be tested without
 * mounting the whole router.
 *
 * The hash is what the previous rule missed. The public header's "Features"
 * link is `/#features`; a signed-in visitor who clicked it was redirected to
 * `/dashboard`, which is the one page the features section is not on — and the
 * redirect dropped the hash on the way, so there was nothing left to scroll to
 * either. A bare `/` still means "take me to my dashboard".
 */
export function landingRouteTarget(options: {
  /** `window.location.hash`, including the leading "#", or "" when absent. */
  hash: string;
  signedIn: boolean;
}): "landing" | "dashboard" {
  const namesASection = options.hash.replace(/^#/, "").length > 0;
  if (namesASection) return "landing";
  return options.signedIn ? "dashboard" : "landing";
}
