/**
 * Shared network mocks for the authenticated E2E specs.
 *
 * IMPORTANT — WHAT THESE TESTS ARE, AND ARE NOT: nothing here talks to a real
 * Supabase project or a real FinSight backend. CI runs the `web` job with
 * placeholder Supabase env vars and starts no backend process at all (see
 * .github/workflows/ci.yml), so every spec that needs an authenticated
 * session or API data intercepts the relevant requests with `page.route()`
 * and answers them with realistic, hand-written JSON shaped to
 * `web/src/lib/types.ts`. This exercises the real React app — real
 * component logic, real client-side validation, real state transitions,
 * real rendering — against a fake network. It is a mocked-network E2E test,
 * not an integration test against a live backend or Supabase instance.
 */
import type { Page } from "@playwright/test";
import type { BusinessProfile, ExpenseCategory, Profile, UserPreferences } from "../src/lib/types";

/** Base64url-encode a UTF-8 string, without Node's Buffer (kept browser-agnostic). */
function base64url(input: string): string {
  const base64 = Buffer.from(input, "utf-8").toString("base64");
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * A JWT-shaped (but unsigned) access token, good enough for supabase-js's
 * client-side `decodeJWT`, which only checks structure and never verifies a
 * signature locally. `exp` is a year out so `setSession` takes the
 * "already valid" path and calls `GET /auth/v1/user` rather than trying to
 * refresh — see supabaseAuthMocks below for why that matters.
 */
export function fakeAccessToken(userId: string, email: string): string {
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = base64url(
    JSON.stringify({
      sub: userId,
      email,
      aud: "authenticated",
      role: "authenticated",
      exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 365,
    }),
  );
  return `${header}.${payload}.e2e-fake-signature`;
}

export const TEST_SUPABASE_USER_ID = "00000000-0000-4000-8000-000000000001";

export const TEST_PROFILE: Profile = {
  id: 1,
  firstName: "Ana",
  middleName: null,
  lastName: "Reyes",
  email: "ana@example.com",
  phoneNumber: null,
  status: "ACTIVE",
  avatarUrl: null,
  createdAt: "2026-01-01T00:00:00.000Z",
};

export const TEST_BUSINESS_PROFILE: BusinessProfile = {
  id: 10,
  name: "Ana's Sari-Sari Store",
  type: "Retail",
  availableFunds: 50000,
  expectedMonthlyExpenses: 20000,
  operatingDays: 26,
  largeExpenseThresholdPercent: 20,
  logoUrl: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  archivedAt: null,
  isArchived: false,
  recordCount: 42,
};

export const TEST_CATEGORIES: ExpenseCategory[] = [
  { id: 100, businessProfileId: 10, name: "Inventory", description: null, createdAt: "2026-01-01T00:00:00.000Z" },
  { id: 101, businessProfileId: 10, name: "Utilities", description: null, createdAt: "2026-01-01T00:00:00.000Z" },
];

/**
 * Mocks the Supabase auth-js calls the app makes directly (never through
 * `api.ts`): `GET /auth/v1/user` (from `setSession`, once per login) and
 * `POST /auth/v1/logout` (from every `signOut()`). Matched by path suffix
 * only — `**` on the left — so this works against both the CI placeholder
 * project URL and a real one, without caring which is configured locally.
 */
export async function mockSupabaseAuth(page: Page) {
  await page.route("**/auth/v1/user", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        id: TEST_SUPABASE_USER_ID,
        aud: "authenticated",
        role: "authenticated",
        email: TEST_PROFILE.email,
      }),
    });
  });
  await page.route("**/auth/v1/logout**", async (route) => {
    await route.fulfill({ status: 204, body: "" });
  });
}

/**
 * Mocks the FinSight backend's `/auth/login` and logout endpoints, and seeds
 * the app shell's always-fetched context (business profiles, categories,
 * notifications) so any authenticated page renders without further setup.
 *
 * Backend base path is matched by suffix (`**\/auth/login` etc.) so it works
 * whatever `VITE_API_BASE_URL` happens to be set to.
 */
export async function mockBackendSession(
  page: Page,
  opts: { profile?: Profile; businessProfiles?: BusinessProfile[]; categories?: ExpenseCategory[] } = {},
) {
  const profile = opts.profile ?? TEST_PROFILE;
  let preferences: UserPreferences = profile.preferences ?? {
    showDashboardMascotMessage: true, tourStatus: null, tourStep: null, tourAlwaysShow: false,
  };
  const businessProfiles = opts.businessProfiles ?? [TEST_BUSINESS_PROFILE];
  const categories = opts.categories ?? TEST_CATEGORIES;

  /*
   * Backstop for any API call no spec thought to mock.
   *
   * Registered FIRST on purpose: Playwright tries handlers most-recent-first,
   * so everything below — and everything a spec adds afterwards — is matched
   * before this one, and only a genuinely unmocked request reaches it.
   *
   * Without it, an unmocked call leaves the browser and is proxied by the Vite
   * dev server to http://localhost:4000 (see web/vite.config.ts). What happens
   * next then depends on the developer's machine rather than on the code: with
   * no backend running the call fails to connect and the app shows a local
   * error, but with a real backend running it answers 401 to the suite's fake
   * token, api.ts fires the session-expired handler, and the owner is thrown
   * back to /login mid-test. That is how receipt-review.spec.ts came to pass in
   * CI (nothing listens on :4000 there) and fail on a machine with `npm run
   * dev` up. Refusing the connection here makes every run behave the same way,
   * and names the missing mock instead of leaving a mystery timeout.
   */
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    console.warn(`[e2e] unmocked API request: ${request.method()} ${request.url()}`);
    await route.abort("connectionrefused");
  });

  await page.route("**/auth/login", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        profile,
        session: {
          access_token: fakeAccessToken(TEST_SUPABASE_USER_ID, profile.email),
          refresh_token: "e2e-fake-refresh-token",
        },
      }),
    });
  });

  await page.route("**/auth/logout", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({}) });
  });

  await page.route("**/auth/me", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...profile, preferences }) });
  });
  await page.route("**/auth/me/preferences", async (route) => {
    if (route.request().method() === "PATCH") preferences = { ...preferences, ...route.request().postDataJSON() };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(preferences) });
  });

  await page.route("**/business-profiles", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(businessProfiles) });
  });

  await page.route("**/records/categories**", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(categories) });
  });

  await page.route("**/records/receipts/provider-consent/**", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ available: false, provider: null, consent: null, activeConsents: [] }),
    });
  });

  await page.route("**/notifications**", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([]) });
  });

  // Dashboard companion data is outside these journeys, but must stay mocked
  // too so the browser suite never needs a running backend.
  await page.route("**/insights/reduction-opportunities**", async (route) => {
    await route.fulfill({ json: {
      period: { days: 30, start: "2026-08-01", end: "2026-08-31" },
      dataQuality: { status: "insufficient", currentRecordCount: 0, previousRecordCount: 0, message: null },
      opportunities: [], detectorVersion: "e2e-fixture",
    } });
  });
}

/**
 * Drives the real login form to establish an authenticated session — a UI
 * interaction, not a shortcut — so AuthContext, BusinessProfileContext and
 * the rest of the provider tree end up in the same state a real sign-in
 * would leave them in.
 */
export async function loginViaUi(page: Page, email = TEST_PROFILE.email, password = "correct-horse-battery") {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Log in" }).click();
  await page.waitForURL("**/business-profiles");
}

/**
 * Use the visible picker, as an owner would. setInputFiles on an sr-only
 * input skips actionability checks and can select a file while the
 * authenticated route is still mounting and the visible picker is unstable.
 */
export async function chooseUpload(
  page: Page,
  label: "Choose a file" | "Choose photos",
  file: { name: string; mimeType: string; buffer: Buffer },
) {
  // Waiting for the picker first turns "the page navigated away and the picker
  // is gone" into that sentence, instead of a 30s timeout on an event that was
  // never going to fire.
  const picker = page.getByText(label, { exact: true });
  await picker.waitFor({ state: "visible" });
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), picker.click()]);
  await chooser.setFiles(file);
}

/**
 * Marks the guided product tour as already completed for the given test
 * user, matching an already-onboarded real user rather than a first-time
 * one. Without this, TourContext's auto-start effect (see
 * src/context/TourContext.tsx) finds `status: "not_started"` and opens the
 * full-screen tour overlay on the dashboard mid-test, which intercepts
 * pointer events and breaks any click the spec makes afterwards. Must run
 * before the first navigation — `addInitScript` seeds localStorage on
 * every subsequent page load, including the one login redirects to.
 */
export async function skipTour(page: Page, userId = TEST_PROFILE.id) {
  await page.addInitScript((id) => {
    window.localStorage.setItem(`finsight.tour.${id}`, JSON.stringify({ status: "completed" }));
  }, userId);
}
