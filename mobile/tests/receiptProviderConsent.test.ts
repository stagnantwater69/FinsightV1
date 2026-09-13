import { describe, expect, it } from "vitest";
import {
  parseReceiptProviderConsentState,
  receiptProviderConsentGrant,
  sameReceiptProviderTerms,
} from "../src/lib/receiptProviderConsent";

const terms = {
  key: "gemini",
  label: "Google Gemini",
  version: "gemini-3.5-flash-lite",
  region: "global",
  policyVersion: "receipt-provider-policy-v1",
  purpose: "RECEIPT_EXTRACTION",
  dataClasses: ["RECEIPT_IMAGE", "DERIVED_RECEIPT_IMAGE"],
  retentionHours: 0,
  trainingAllowed: false,
  revocable: true,
};

describe("receipt provider consent contract", () => {
  it("echoes only the exact advertised terms in a grant", () => {
    const state = parseReceiptProviderConsentState({
      available: true,
      provider: terms,
      consent: null,
      activeConsents: [],
    });
    expect(state?.available).toBe(true);
    expect(receiptProviderConsentGrant(state!.provider!)).toEqual({
      provider: "gemini",
      policyVersion: "receipt-provider-policy-v1",
      purpose: "RECEIPT_EXTRACTION",
      dataClasses: ["RECEIPT_IMAGE", "DERIVED_RECEIPT_IMAGE"],
      region: "global",
      retentionHours: 0,
      trainingAllowed: false,
    });
    expect(sameReceiptProviderTerms(state!.provider!, state!.provider!)).toBe(true);
    expect(sameReceiptProviderTerms(state!.provider!, { ...state!.provider!, region: "us" })).toBe(false);
  });

  it.each([
    { ...terms, trainingAllowed: true },
    { ...terms, dataClasses: ["DERIVED_RECEIPT_IMAGE", "RECEIPT_IMAGE"] },
    { ...terms, purpose: "GENERAL_AI" },
    { ...terms, retentionHours: 25 },
  ])("rejects incomplete or broadened provider terms", (provider) => {
    expect(parseReceiptProviderConsentState({
      available: true,
      provider,
      consent: null,
      activeConsents: [],
    })).toBeNull();
  });

  it("accepts a revoke-only state while provider dispatch is unavailable", () => {
    const state = parseReceiptProviderConsentState({
      available: false,
      provider: null,
      consent: null,
      activeConsents: [{
        reference: "consent:7",
        provider: "veryfi",
        policyVersion: "receipt-provider-policy-v1",
        purpose: "RECEIPT_EXTRACTION",
        dataClasses: ["RECEIPT_IMAGE", "DERIVED_RECEIPT_IMAGE"],
        region: "us",
        retentionHours: 24,
        trainingAllowed: false,
        grantedAt: "2026-09-13T08:00:00.000Z",
        revocable: true,
      }],
    });
    expect(state).toMatchObject({ available: false, provider: null, consent: null });
    expect(state?.activeConsents).toHaveLength(1);
  });

  it("does not expose grant terms when unavailable", () => {
    expect(parseReceiptProviderConsentState({
      available: false,
      provider: terms,
      consent: null,
      activeConsents: [],
    })).toBeNull();
  });
});
