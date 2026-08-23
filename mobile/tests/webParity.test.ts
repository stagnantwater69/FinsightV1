import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { BAND_COPY, confidenceBand, findingSignalStrength, scanConfidenceBand } from "../src/lib/confidenceBands";
import { feedbackActions } from "../src/lib/findingFeedback";
import { groupConversations } from "../src/lib/conversationGroups";
import { TOUR_STEPS } from "../src/components/tour/steps";
import { shouldStartTour } from "../src/lib/tourGating";

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

/**
 * Every `<Route path="...">` in web's router, except the catch-all.
 *
 * `path="*"` is not a page and has no mobile counterpart to argue about: it is
 * web's 404 for a URL that matched nothing, and the app has no address bar for
 * anyone to mistype into. Counting it would demand a written "why doesn't
 * mobile have this?" decision about a concept that cannot exist there.
 */
function webRoutes(): string[] {
  const src = readFileSync(WEB_APP, "utf8");
  return [...src.matchAll(/<Route\s+path="([^"]+)"/g)].map((m) => m[1]!).filter((p) => p !== "*");
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
   * Web splits declaring a repeating payment from editing one; mobile serves
   * both from a single form keyed on a `scheduleId` route param, the same way
   * it serves new and existing business profiles from BusinessProfileForm.
   * The capability is what has to match, not the shape of the URLs.
   */
  "/insights/recurring-schedules/new": "RecurringSchedule",
  "/insights/recurring-schedules/:id/edit": "RecurringSchedule",
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

/**
 * The two apps must not disagree about how trustworthy a scan is, or about
 * what an owner just said about a flag.
 *
 * WHY THIS IS WORTH A TEST RATHER THAN A COMMENT: it has already happened.
 * The same OCR percentage drove four different cutoffs — 75 to route a scan to
 * the vision model, 80 and 60 to colour the web review screen, 75 again for a
 * single item's amount on both clients — so one receipt could be presented as
 * fine on a laptop and as suspect on a phone. ADR-4 in
 * docs/ML-OCR-CSV-UI-PROGRAM.md replaced them with one mapping, and a mapping
 * COPIED into two apps (which it is, deliberately — see tokens.ts for why the
 * two projects share no build) is a mapping that will drift again.
 *
 * So this imports both implementations and runs them against each other,
 * rather than checking that a file exists or that a comment says they match.
 * The `existsSync` guard is only there so that whichever client lands first
 * does not fail on the other's absence.
 */
const WEB_BANDS = join(__dirname, "..", "..", "web", "src", "lib", "confidenceBands.ts");
const WEB_FINDINGS = join(__dirname, "..", "..", "web", "src", "lib", "findingPresentation.ts");

describe("receipt confidence bands match web", () => {
  it("uses the three labels ADR-4 fixed for both clients", () => {
    expect([BAND_COPY.clear.label, BAND_COPY.check.label, BAND_COPY.review.label]).toEqual([
      "Looks clear",
      "Check a few fields",
      "Review carefully",
    ]);
  });

  it.skipIf(!existsSync(WEB_BANDS))("agrees with web's band for every reading", async () => {
    const web = (await import(WEB_BANDS)) as typeof import("../../web/src/lib/confidenceBands");

    const confidences: (number | null | undefined)[] = [null, undefined, 0, 33, 56, 59, 60, 75, 79, 80, 89, 95, 100];
    const disagreements: string[] = [];
    for (const confidence of confidences) {
      for (const visionAssisted of [false, true]) {
        const mine = confidenceBand({ confidence, visionAssisted });
        const theirs = web.confidenceBand({ confidence, visionAssisted });
        if (mine !== theirs) {
          disagreements.push(`confidence=${confidence} vision=${visionAssisted}: app "${mine}" vs web "${theirs}"`);
        }
        // The words matter as much as the band: two clients agreeing on
        // "check" while calling it different things is the same defect.
        if (BAND_COPY[mine].label !== web.BAND_COPY[theirs].label) {
          disagreements.push(`label for ${mine}: app "${BAND_COPY[mine].label}" vs web "${web.BAND_COPY[theirs].label}"`);
        }
      }
    }
    expect(
      disagreements,
      `The same scan would be described differently on the two clients:\n${disagreements.join("\n")}`,
    ).toEqual([]);
  });

  it.skipIf(!existsSync(WEB_BANDS))("agrees with web's whole-scan cue", async () => {
    const web = (await import(WEB_BANDS)) as typeof import("../../web/src/lib/confidenceBands");
    const scans = [
      { ocrConfidence: 95, items: [{ amountConfidence: 96 }, { amountConfidence: 30 }] },
      { ocrConfidence: 95, visionAssisted: true, items: [] },
      { ocrConfidence: null, items: [{ extractedByVision: true }] },
      { ocrConfidence: 85, items: [{}, {}] },
    ];
    for (const scan of scans) {
      expect(scanConfidenceBand(scan), JSON.stringify(scan)).toBe(web.scanConfidenceBand(scan));
    }
  });

  it.skipIf(!existsSync(WEB_BANDS))("agrees with web on how strong a finding's signal is", async () => {
    const web = (await import(WEB_BANDS)) as typeof import("../../web/src/lib/confidenceBands");
    for (const severity of ["LOW", "MEDIUM", "HIGH"] as const) {
      for (const score of [null, 0.1, 0.85, 0.99]) {
        expect(findingSignalStrength(severity, score), `${severity}/${score}`).toBe(
          web.findingSignalStrength(severity, score),
        );
      }
    }
  });
});

/**
 * The product tour must teach the same app on both clients.
 *
 * WHY THIS BELONGS IN THE PARITY FILE: the tour is the one surface that makes
 * promises ABOUT the product, in sentences, to someone who has just arrived.
 * Two clients describing the same feature differently — or one client quietly
 * dropping a step because the phone build lacks the feature — is the same
 * class of defect this file was written for, and it is invisible until
 * somebody reads both tours side by side.
 *
 * The step CONTENT is compared literally; the TARGETS deliberately are not.
 * Web points at CSS selectors in a sidebar, the app points at registry keys on
 * a tab bar — the same feature reached differently, which is exactly the kind
 * of difference COVERED above already allows for routes.
 */
const WEB_TOUR_STEPS = join(__dirname, "..", "..", "web", "src", "components", "tour", "steps.tsx");
const WEB_TOUR_CONTEXT = join(__dirname, "..", "..", "web", "src", "context", "TourContext.tsx");

/**
 * THE SECOND DELIBERATE DIVERGENCE (the first is the always-show preference,
 * pinned at the bottom of this file).
 *
 * The phone teaches two actions inside the "+" menu that web's sidebar
 * Quick-add does not need explained: web's menu is a labelled list on a screen
 * an owner can read at leisure, the phone's is a ring of unlabelled circles
 * that appears and disappears with the step. Recording money by hand is also
 * the only route in for an owner with no receipt and no spreadsheet.
 *
 * Listed here rather than allowed as "any extra step", so a step that drifts
 * onto one client by accident still fails this file.
 */
const MOBILE_ONLY_STEPS = ["manual-entry", "sales-reference"];

describe("product tour matches web", () => {
  it.skipIf(!existsSync(WEB_TOUR_STEPS))("walks web's steps in web's order", async () => {
    const web = (await import(WEB_TOUR_STEPS)) as typeof import("../../web/src/components/tour/steps");
    const shared = TOUR_STEPS.map((s) => s.id).filter((id) => !MOBILE_ONLY_STEPS.includes(id));
    expect(
      shared,
      "Every one of web's ten steps names a feature the app has too — see steps.ts for how each target was re-pointed",
    ).toEqual(web.TOUR_STEPS.map((s) => s.id));
  });

  it.skipIf(!existsSync(WEB_TOUR_STEPS))("adds only the quick-add steps on top of them", async () => {
    const web = (await import(WEB_TOUR_STEPS)) as typeof import("../../web/src/components/tour/steps");
    const webIds = new Set(web.TOUR_STEPS.map((s) => s.id));
    const extra = TOUR_STEPS.map((s) => s.id).filter((id) => !webIds.has(id));
    expect(extra, "A step exists on the phone that web has never heard of").toEqual(
      MOBILE_ONLY_STEPS,
    );
    // And they are taught where the divergence is justified: inside the menu.
    for (const id of MOBILE_ONLY_STEPS) {
      expect(TOUR_STEPS.find((s) => s.id === id)?.requiresQuickAdd).toBe(true);
    }
  });

  it.skipIf(!existsSync(WEB_TOUR_STEPS))("says the same thing on every step", async () => {
    const web = (await import(WEB_TOUR_STEPS)) as typeof import("../../web/src/components/tour/steps");
    const drift: string[] = [];
    for (const step of TOUR_STEPS) {
      const theirs = web.TOUR_STEPS.find((s) => s.id === step.id);
      if (!theirs) continue;
      if (theirs.title !== step.title) drift.push(`${step.id} title: "${step.title}" vs "${theirs.title}"`);
      if (theirs.body !== step.body) drift.push(`${step.id} body: "${step.body}" vs "${theirs.body}"`);
    }
    expect(drift, `The two tours describe the same feature differently:\n${drift.join("\n")}`).toEqual([]);
  });

  /**
   * The gate, compared against web's conditions rather than against its code:
   * web decides inside a React effect that cannot be imported here, so its
   * source is read to confirm the conditions are still the ones the app's pure
   * `shouldStartTour` was written to mirror, and then the app's function is
   * driven through them.
   */
  it.skipIf(!existsSync(WEB_TOUR_CONTEXT))("refuses to start in the same situations web does", async () => {
    const source = readFileSync(WEB_TOUR_CONTEXT, "utf8");
    for (const condition of ['=== "completed"', '=== "skipped"', "!selected", "loading"]) {
      expect(source, `web's start gate no longer mentions ${condition}`).toContain(condition);
    }

    const ready = {
      status: "not_started" as const,
      alwaysShow: false,
      hasProfile: true,
      dashboardLoaded: true,
      onHomeTab: true,
    };
    expect(shouldStartTour(ready)).toBe(true);
    expect(shouldStartTour({ ...ready, status: "completed" })).toBe(false);
    expect(shouldStartTour({ ...ready, status: "skipped" })).toBe(false);
    expect(shouldStartTour({ ...ready, hasProfile: false })).toBe(false);
    expect(shouldStartTour({ ...ready, dashboardLoaded: false })).toBe(false);
  });

  /**
   * ONE DELIBERATE DIVERGENCE, recorded here rather than left to be found.
   *
   * The app has "Always show the tour on login" (More → Preferences) and web
   * has no such preference. It exists so the first-run experience can be shown
   * repeatedly — a demo, a new helper behind the counter — without creating a
   * throwaway account, which is a phone problem rather than a laptop one. It
   * only ever LOOSENS the gate, and only the two terminal statuses; the
   * business-profile and loaded-Home conditions are untouched by it, which is
   * what keeps the two clients' gates the same gate.
   */
  it("adds only the always-show preference on top of web's rules", () => {
    const base = {
      alwaysShow: true,
      hasProfile: true,
      dashboardLoaded: true,
      onHomeTab: true,
    };
    expect(shouldStartTour({ ...base, status: "completed" })).toBe(true);
    expect(shouldStartTour({ ...base, status: "skipped" })).toBe(true);
    expect(shouldStartTour({ ...base, status: "completed", hasProfile: false })).toBe(false);
    expect(shouldStartTour({ ...base, status: "completed", dashboardLoaded: false })).toBe(false);
  });
});

/**
 * Chat history must be filed under the same headings on both clients.
 *
 * WHY THIS IS HERE AND NOT ONLY IN conversationGroups.test.ts: the app's
 * lib/conversationGroups.ts is a DELIBERATE COPY of web's, exactly like
 * confidenceBands.ts — the two projects share no build, so there is nothing
 * except this file to stop one of them being edited alone. The failure mode is
 * quiet and specific: an owner who moves an hour of enquiry between the phone
 * and the laptop finds the same conversation under "Previous 7 Days" on one and
 * "Previous 30 Days" on the other, and neither screen looks wrong.
 *
 * Both boundaries are counted from today because both headings name a window
 * that includes today, so seven days ago has already LEFT "Previous 7 Days".
 * That off-by-one is the thing most likely to be re-derived differently, so it
 * is driven through both implementations rather than described.
 */
const WEB_CONVERSATION_GROUPS = join(__dirname, "..", "..", "web", "src", "lib", "conversationGroups.ts");

describe("chat history grouping matches web", () => {
  const NOW = new Date(2026, 7, 23, 9, 30);
  const daysBefore = (days: number) =>
    new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() - days, 12);

  /** One conversation per day offset, so every bucket and both edges are covered. */
  const OFFSETS = [-1, 0, 1, 2, 6, 7, 8, 29, 30, 31, 400];
  const rows = OFFSETS.map((days, index) => ({
    id: index + 1,
    title: `${days} days ago`,
    originModule: "Dashboard" as const,
    createdAt: daysBefore(days).toISOString(),
    lastMessageAt: daysBefore(days).toISOString(),
  }));

  it("uses the five labels, in order, with the boundaries on web's side of the line", () => {
    const groups = groupConversations(rows, NOW);
    expect(groups.map((g) => g.label)).toEqual([
      "Today",
      "Yesterday",
      "Previous 7 Days",
      "Previous 30 Days",
      "Older",
    ]);

    const labelOf = (days: number) =>
      groups.find((g) => g.conversations.some((c) => c.title === `${days} days ago`))?.label;
    expect(labelOf(0), "today").toBe("Today");
    expect(labelOf(1), "yesterday").toBe("Yesterday");
    expect(labelOf(6), "inside the seven-day window").toBe("Previous 7 Days");
    expect(labelOf(7), "exactly seven days ago has left the seven-day window").toBe("Previous 30 Days");
    expect(labelOf(29), "inside the thirty-day window").toBe("Previous 30 Days");
    expect(labelOf(30), "exactly thirty days ago has left the thirty-day window").toBe("Older");
  });

  it.skipIf(!existsSync(WEB_CONVERSATION_GROUPS))("files every conversation exactly where web does", async () => {
    const web = (await import(WEB_CONVERSATION_GROUPS)) as typeof import("../../web/src/lib/conversationGroups");

    const mine = groupConversations(rows, NOW);
    const theirs = web.groupConversations(rows, NOW);

    expect(
      mine.map((g) => ({ label: g.label, titles: g.conversations.map((c) => c.title) })),
      "The same conversation would be filed under a different heading on the two clients",
    ).toEqual(theirs.map((g) => ({ label: g.label, titles: g.conversations.map((c) => c.title) })));
  });
});

/**
 * What an owner says about a finding must mean the same thing on both clients.
 *
 * This one is not cosmetic: the five feedback values are the labels the
 * evaluation harness measures detector precision against. If the app writes
 * DISMISSED where the website writes RESOLVED for the same sentence, the
 * dataset the thresholds are set from is quietly poisoned — and nothing on
 * either screen would look wrong.
 */
describe("finding feedback matches web", () => {
  it("makes all five values reachable", () => {
    for (const category of ["duplicate", "unusual"] as const) {
      const feedbacks = feedbackActions(category).map((a) => a.feedback);
      expect(new Set(feedbacks).size).toBe(5);
      expect(feedbacks).toContain("INCORRECT_MATCH");
      expect(feedbacks).toContain("NO_LONGER_RELEVANT");
    }
  });

  it.skipIf(!existsSync(WEB_FINDINGS))("uses web's labels, statuses and ordering", async () => {
    const web = (await import(WEB_FINDINGS)) as typeof import("../../web/src/lib/findingPresentation");
    for (const category of ["duplicate", "unusual"] as const) {
      const mine = feedbackActions(category).map(({ feedback, status, label }) => ({ feedback, status, label }));
      const theirs = web.feedbackActions(category).map(({ feedback, status, label }) => ({ feedback, status, label }));
      expect(mine, `feedback actions for "${category}"`).toEqual(theirs);
    }
  });
});
