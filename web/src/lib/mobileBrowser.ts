/**
 * "Is this browser running on a phone or a tablet?"
 *
 * Used for ONE thing: whether to offer "Open in the FinSight app" after an
 * email confirmation. That affordance is a dead link on a desktop — the
 * `finsight://` scheme is registered by the Expo app and nothing else — so
 * showing it there would be offering a button that visibly does nothing.
 *
 * WHY USER-AGENT SNIFFING, which is otherwise a bad habit. The question is not
 * "how wide is the viewport" (a narrow desktop window is still a desktop) and
 * not "is there a touch screen" (touch laptops say yes). It is "could this
 * device plausibly have the app installed", and the UA string is the only
 * signal that answers it. Being wrong is cheap in both directions: a false
 * positive shows a button that falls back to staying on the web, a false
 * negative just leaves the owner on the web app where they are already signed
 * in. Nothing about access depends on this answer.
 */

/*
 * iPadOS reports a desktop Safari UA by default ("Macintosh; Intel Mac OS X"),
 * so it is matched on the touch-point count instead — a Mac reports 0.
 */
function isDesktopClassIpad(userAgent: string, maxTouchPoints: number): boolean {
  return /Macintosh/i.test(userAgent) && maxTouchPoints > 1;
}

export function isMobileUserAgent(userAgent: string, maxTouchPoints = 0): boolean {
  if (!userAgent) return false;
  if (/Android|iPhone|iPad|iPod|Windows Phone|webOS|BlackBerry|Opera Mini|IEMobile/i.test(userAgent)) return true;
  return isDesktopClassIpad(userAgent, maxTouchPoints);
}

/** The browser-reading wrapper, so callers need no `window` guard of their own. */
export function isMobileBrowser(): boolean {
  if (typeof navigator === "undefined") return false;
  return isMobileUserAgent(navigator.userAgent ?? "", navigator.maxTouchPoints ?? 0);
}
