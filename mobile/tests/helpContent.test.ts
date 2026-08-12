import { describe, expect, it } from "vitest";
import * as mobile from "../src/lib/helpContent";
// Imported ACROSS the project boundary on purpose — this is web's real copy,
// not a fixture of it. Neither file imports React or React Native, so both
// load fine here. Same technique, and the same reason, as
// backend/tests/contract/clientPayloads.test.ts.
import * as web from "../../web/src/lib/marketingContent";

/**
 * The app's help and legal copy must be the website's, word for word.
 *
 * WHY THIS FILE EXISTS: web and mobile are separate packages with no workspace
 * linking them, and Metro cannot bundle a file from outside the mobile project
 * root — so the copy in src/lib/helpContent.ts is a real second copy, free to
 * drift exactly as mobile's receipt payload once drifted from the server's
 * schema.
 *
 * What makes drift unacceptable HERE rather than merely untidy: the panel
 * found most small business owners have a phone and no computer. For those
 * owners the app is the only place they will ever read the privacy notice or
 * the terms. Two versions of that document, with the one they happen to see
 * being the stale one, is not a cosmetic problem.
 *
 * Whole objects are compared rather than field counts, so ADDING a section to
 * one side fails as loudly as editing one. A test that only checked lengths
 * would pass while the two said different things.
 */
describe("help and legal copy matches the website", () => {
  it("loads both copies at all", () => {
    // Guards the test itself: if either import resolved to an empty module,
    // every assertion below would pass vacuously.
    expect(web.FAQS.length).toBeGreaterThan(5);
    expect(mobile.FAQS.length).toBeGreaterThan(5);
  });

  it("has the same FAQs, in the same order, with the same topics", () => {
    expect(mobile.FAQS).toEqual(web.FAQS);
    expect(mobile.FAQ_TOPICS).toEqual(web.FAQ_TOPICS);
  });

  it("has the same tutorials", () => {
    expect(mobile.TUTORIALS).toEqual(web.TUTORIALS);
  });

  /**
   * The two that matter most. A privacy notice or a set of terms that differs
   * between the platform someone reads it on and the platform it was written
   * for is the failure this whole file exists to prevent.
   */
  it("has the same privacy notice, including its disclaimer", () => {
    expect(mobile.PRIVACY_SECTIONS).toEqual(web.PRIVACY_SECTIONS);
    expect(mobile.PRIVACY_DISCLAIMER).toBe(web.PRIVACY_DISCLAIMER);
  });

  it("has the same terms, including its disclaimer", () => {
    expect(mobile.TERMS_SECTIONS).toEqual(web.TERMS_SECTIONS);
    expect(mobile.TERMS_DISCLAIMER).toBe(web.TERMS_DISCLAIMER);
  });

  it("names the same disclaimer heading and support address", () => {
    expect(mobile.LEGAL_DISCLAIMER_HEADING).toBe(web.LEGAL_DISCLAIMER_HEADING);
    expect(mobile.SUPPORT_EMAIL).toBe(web.SUPPORT_EMAIL);
  });

  /**
   * Catches a section added to one file and not the other, which the
   * per-constant assertions above would already fail — but this one names the
   * cause directly instead of printing two long section arrays to diff by eye.
   */
  it("exports the same set of content keys", () => {
    const contentKeys = (m: object) => Object.keys(m).sort();
    expect(contentKeys(mobile)).toEqual(contentKeys(web));
  });
});
