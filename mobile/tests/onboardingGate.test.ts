import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// SecureStore is the only native dependency onboardingDraft.ts has, and none of
// the gate logic touches it. Stubbed so the pure function can be reached from
// the source project, which installs no native-module aliases.
vi.mock("expo-secure-store", () => ({
  getItemAsync: async () => null,
  setItemAsync: async () => undefined,
  deleteItemAsync: async () => undefined,
}));

const { shouldShowOnboarding } = await import("../src/lib/onboardingDraft");

const APP = readFileSync(join(__dirname, "..", "App.tsx"), "utf8");

/**
 * MOB-002. Step 3 of the first-run wizard was unreachable.
 *
 * The gate in App.tsx was `profiles.length === 0 && !dismissed && !left`, read
 * live off BusinessProfileContext — and the wizard creates the business profile
 * at the END OF STEP 2. `createProfile` appends the created row to `profiles`,
 * so `profiles.length` became 1 in the same tick that `setStep(3)` was queued,
 * the gate went false, and the whole wizard unmounted before step 3 could
 * render. Nobody on the first-run path ever saw the readiness summary or the
 * four "what would you like to do first" actions.
 *
 * These assert the LATCH, which is the fix: entry is still decided by the
 * profile list, but staying is not.
 */
describe("the first-run onboarding gate", () => {
  const base = { hasProfiles: false, dismissed: false, finished: false, entered: false };

  it("opens for a signed-in owner with no business", () => {
    expect(shouldShowOnboarding(base)).toBe(true);
  });

  it("never opens for an owner who already has a business", () => {
    expect(shouldShowOnboarding({ ...base, hasProfiles: true })).toBe(false);
  });

  /** The regression itself. */
  it("stays open after step 2 creates the profile", () => {
    // Step 1 → the wizard is on screen, so the latch is set.
    expect(shouldShowOnboarding(base)).toBe(true);
    // Step 2 succeeds: the profile now exists and the live list says so.
    expect(shouldShowOnboarding({ ...base, hasProfiles: true, entered: true })).toBe(true);
  });

  it("closes when the owner leaves step 3, and not before", () => {
    expect(shouldShowOnboarding({ ...base, hasProfiles: true, entered: true, finished: true })).toBe(false);
  });

  it("closes when the owner skips, even mid-flow", () => {
    expect(shouldShowOnboarding({ ...base, entered: true, dismissed: true })).toBe(false);
  });

  /**
   * A dismissal recorded on an earlier launch must not be re-entered on this
   * one — a skip that does not skip is worse than no skip button at all.
   */
  it("respects a dismissal from a previous launch", () => {
    expect(shouldShowOnboarding({ ...base, dismissed: true })).toBe(false);
  });
});

/**
 * App.tsx cannot be mounted by this runner, so the wiring is read instead —
 * the same technique tests/navigationTargets.test.ts uses.
 */
describe("App.tsx uses the latch", () => {
  it("asks shouldShowOnboarding rather than re-deriving the gate inline", () => {
    expect(APP).toContain("shouldShowOnboarding({");
    expect(APP).not.toContain("profiles.length === 0 && !dismissed && !left");
  });

  it("passes the latch in and sets it on the render that shows the wizard", () => {
    expect(APP).toMatch(/entered: enteredWizard\.current/);
    expect(APP).toMatch(/enteredWizard\.current = true;\s*\n\s*return \(\s*\n\s*<OnboardingScreen/);
  });

  /**
   * The same defect in a different disguise: a `refresh()` that flips
   * BusinessProfileContext's `loading` back to true mid-setup would swap the
   * owner's half-filled form for a spinner and lose the step they were on.
   */
  it("does not fall back to the loading spinner once the wizard is up", () => {
    expect(APP).toContain("if (!enteredWizard.current && (loading || dismissed === null))");
  });
});
