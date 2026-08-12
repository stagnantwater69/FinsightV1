import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

/**
 * Every page the website has, the app has — or has a written reason not to.
 *
 * WHY THIS FILE EXISTS: the app quietly fell behind the website and nobody
 * noticed until it was asked about directly. Expense categories could be
 * created on mobile only sideways, from inside the add-expense picker, and
 * there was no screen listing them; the privacy notice and terms existed only
 * on a website. Neither absence broke anything, which is exactly why neither
 * was found — a missing screen has no failing test and no error in a log.
 *
 * It matters more than ordinary parity because of who the users are: the
 * review panel found most small business owners have a phone and no computer.
 * "It's on the website" is not an answer for them. A page that exists only on
 * the web effectively does not exist.
 *
 * HOW IT WORKS: web's routes are read from its router, and each must appear in
 * exactly one of the two lists below. Adding a route to the website with no
 * entry here fails this test — not because the app must grow a screen, but
 * because somebody has to make the decision and write down which way it went.
 */

const WEB_APP = join(__dirname, "..", "..", "web", "src", "App.tsx");
const MOBILE_APP = join(__dirname, "..", "App.tsx");

/** Every `<Route path="...">` in web's router. */
function webRoutes(): string[] {
  const src = readFileSync(WEB_APP, "utf8");
  return [...src.matchAll(/<Route\s+path="([^"]+)"/g)].map((m) => m[1]!);
}

/** Every `<Stack.Screen name="...">` / `<Tab.Screen name="...">` in the app. */
function mobileScreens(): Set<string> {
  const src = readFileSync(MOBILE_APP, "utf8");
  const registered = [...src.matchAll(/<(?:Stack|Tab)\.Screen\s+name="([^"]+)"/g)].map((m) => m[1]!);

  /*
   * Screens the app renders DIRECTLY rather than registering on a navigator.
   *
   * The two auth-deep-link screens are reached from a link in an email, not by
   * navigating, and they have to win over whatever is currently on screen —
   * including a signed-in session, because "reset my password" is exactly what
   * someone does when they think another person has their account. So App.tsx
   * renders them above the navigator instead of pushing them onto a stack, and
   * a check that only looked for `<Stack.Screen>` would call them missing.
   *
   * The `Screen` suffix is dropped so the COVERED table can name them the same
   * way it names every other one.
   */
  const rendered = [...src.matchAll(/<([A-Z][A-Za-z]*)Screen[\s/>]/g)].map((m) => m[1]!);

  return new Set([...registered, ...rendered]);
}

/**
 * Web route -> the screen that covers it on mobile.
 *
 * Several web routes collapse into one mobile screen, which is not a gap: a
 * phone edits an expense and a sales record through the same screen, and
 * creates and edits a business profile through one form. What matters is that
 * the CAPABILITY is reachable, not that the navigation shape matches.
 */
const COVERED: Record<string, string> = {
  "/dashboard": "DashboardHome",
  "/notifications": "Notifications",
  "/profile": "Profile",
  "/business-profiles": "BusinessProfiles",
  "/business-profiles/all": "BusinessProfiles",
  "/business-profiles/new": "BusinessProfileForm",
  "/business-profiles/:id/edit": "BusinessProfileForm",
  "/records": "RecordsList",
  "/records/categories": "Categories",
  "/records/expenses/new": "AddExpense",
  "/records/expenses/:id/edit": "EditRecord",
  "/records/sales/new": "AddSales",
  "/records/sales/:id/edit": "EditRecord",
  "/records/receipts/new": "ScanReceipt",
  "/records/csv-imports/new": "ImportCsv",
  "/records/flagged": "FlaggedRecords",
  "/insights/expense-behavior": "ExpenseBehavior",
  "/insights/recovery": "RecoveryTarget",
  "/insights/spending-impact": "SpendingImpact",
  /*
   * The three-step business setup. On mobile it is not only a stack screen:
   * App.tsx renders it INSTEAD of the tabs when a signed-in owner has no
   * business yet, which is the same automatic entry the web gets from
   * RequireBusinessProfile. The registered screen is the deliberate way back in
   * for someone who chose "Skip for now", matching the web's /onboarding being
   * navigable at any time.
   */
  "/onboarding": "Onboarding",
  "/login": "Login",
  "/register": "Register",
  "/recover-password": "RecoverPassword",
  /*
   * These two are reached by a link in an email rather than by navigating, so
   * on mobile they are not stack screens: App.tsx renders them ABOVE the
   * navigator when a `finsight://` auth deep link arrives. The parity that
   * matters is that the capability is reachable, and it is — from the same
   * email, on the same phone. `mobileScreens()` picks them up from the JSX that
   * renders them, which is what keeps this entry honest rather than decorative.
   */
  "/auth/reset-password": "ResetPassword",
  "/auth/confirm": "ConfirmEmail",
  "/faqs": "Faqs",
  "/tutorials": "Tutorials",
  "/contact": "Contact",
  "/privacy": "Privacy",
  "/terms": "Terms",
};

/**
 * Web-only, each with the reason. A reason is required: "not built yet" is a
 * legitimate entry, but it has to be written down rather than left as silence.
 */
const WEB_ONLY: Record<string, string> = {
  "/": "The marketing landing page. The app opens to a login or the dashboard — there is no equivalent surface, and an installed app has already done the job a landing page exists to do.",
  "/blogs": "Marketing content for visitors deciding whether to sign up. A signed-in owner opening the app is past that decision, and the app is not where they would look for it.",
};

describe("web feature parity", () => {
  it("finds both routers at all", () => {
    // Guards the test itself: a regex that stopped matching would make every
    // assertion below pass vacuously and prove nothing.
    expect(webRoutes().length).toBeGreaterThan(10);
    expect(mobileScreens().size).toBeGreaterThan(10);
  });

  it("accounts for every web route, as covered or as deliberately web-only", () => {
    const unaccounted = webRoutes().filter((r) => !(r in COVERED) && !(r in WEB_ONLY));
    expect(
      unaccounted,
      `New web route(s) with no decision recorded for mobile: ${unaccounted.join(", ")}. ` +
        `Add each to COVERED (with the screen that covers it) or to WEB_ONLY (with the reason).`,
    ).toEqual([]);
  });

  it("registers every screen claimed to cover a web route", () => {
    const registered = mobileScreens();
    const missing = Object.entries(COVERED)
      .filter(([, screen]) => !registered.has(screen))
      .map(([route, screen]) => `${route} -> ${screen}`);
    expect(missing, `Claimed as covered, but no such screen is registered: ${missing.join(", ")}`).toEqual([]);
  });

  it("does not claim a route is both covered and web-only", () => {
    const both = Object.keys(COVERED).filter((r) => r in WEB_ONLY);
    expect(both).toEqual([]);
  });

  /**
   * The two that a phone-only owner cannot be sent to a website to read.
   * Pinned by name rather than left to the mapping above, so removing them
   * from the app fails with a message that says why it matters.
   */
  it("keeps the privacy notice and the terms inside the app", () => {
    const registered = mobileScreens();
    expect(registered.has("Privacy"), "Privacy must be readable in the app, not only on the website").toBe(true);
    expect(registered.has("Terms"), "Terms must be readable in the app, not only on the website").toBe(true);
  });
});
