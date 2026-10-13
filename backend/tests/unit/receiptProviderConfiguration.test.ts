import { describe, expect, it } from "vitest";
import {
  RECEIPT_PROVIDER_PHASE1_MONTHLY_UNIT_CAP,
  RECEIPT_PROVIDER_TIMEOUT_MS,
  getReceiptProviderConfiguration,
  publicReceiptProviderDetails,
  receiptProviderGateTimeoutMs,
} from "../../src/config/receiptProvider";

function operationalGeminiEnv(): NodeJS.ProcessEnv {
  return {
    RECEIPT_PROVIDER_DISPATCH_ENABLED: "true",
    RECEIPT_PROVIDER_KILL_SWITCH: "false",
    RECEIPT_PROVIDER_DATA_TERMS_APPROVED: "true",
    RECEIPT_PROVIDER: "gemini",
    RECEIPT_PROVIDER_VERSION: "gemini-3.5-flash-lite",
    RECEIPT_PROVIDER_REGION: "global",
    RECEIPT_PROVIDER_RETENTION_HOURS: "0",
    RECEIPT_PROVIDER_ROUTING_CALIBRATED: "true",
    RECEIPT_PROVIDER_CALIBRATION_VERSION: "receipt-routing-2026-09",
    RECEIPT_PROVIDER_MONTHLY_UNIT_LIMIT: "100",
    GOOGLE_GEMINI_API_KEY: "mocked-provider-key",
  };
}

describe("receipt provider configuration", () => {
  it("is operational only when every approved Gemini prerequisite is present", () => {
    const config = getReceiptProviderConfiguration(operationalGeminiEnv());

    expect(config).toMatchObject({
      operational: true,
      dispatchEnabled: true,
      killSwitchActive: false,
      dataTermsApproved: true,
      routingCalibrated: true,
      provider: "gemini",
      providerVersion: "gemini-3.5-flash-lite",
      providerRegion: "global",
      providerRetentionHours: 0,
      providerTrainingAllowed: false,
      resourceMonthlyUnitLimit: RECEIPT_PROVIDER_PHASE1_MONTHLY_UNIT_CAP,
      businessMonthlyUnitLimit: null,
      unitType: "DOCUMENT",
    });
    expect(publicReceiptProviderDetails(config)).toEqual({
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
    });
  });

  it("does not let credentials enable dispatch by themselves", () => {
    const config = getReceiptProviderConfiguration({
      RECEIPT_PROVIDER: "gemini",
      GOOGLE_GEMINI_API_KEY: "mocked-provider-key",
    });

    expect(config.operational).toBe(false);
    expect(config.dispatchEnabled).toBe(false);
    expect(config.killSwitchActive).toBe(true);
    expect(config.resourceMonthlyUnitLimit).toBe(0);
    expect(publicReceiptProviderDetails(config)).toBeNull();
  });

  it.each([
    ["enable flag absent", "RECEIPT_PROVIDER_DISPATCH_ENABLED", undefined],
    ["enable flag false", "RECEIPT_PROVIDER_DISPATCH_ENABLED", "false"],
    ["enable flag malformed", "RECEIPT_PROVIDER_DISPATCH_ENABLED", "TRUE"],
    ["kill switch absent", "RECEIPT_PROVIDER_KILL_SWITCH", undefined],
    ["kill switch active", "RECEIPT_PROVIDER_KILL_SWITCH", "true"],
    ["kill switch malformed", "RECEIPT_PROVIDER_KILL_SWITCH", "0"],
    ["data terms absent", "RECEIPT_PROVIDER_DATA_TERMS_APPROVED", undefined],
    ["data terms unapproved", "RECEIPT_PROVIDER_DATA_TERMS_APPROVED", "false"],
    ["routing calibration absent", "RECEIPT_PROVIDER_ROUTING_CALIBRATED", undefined],
    ["routing uncalibrated", "RECEIPT_PROVIDER_ROUTING_CALIBRATED", "false"],
    ["calibration version absent", "RECEIPT_PROVIDER_CALIBRATION_VERSION", undefined],
    ["calibration version invalid", "RECEIPT_PROVIDER_CALIBRATION_VERSION", "bad version"],
    ["provider absent", "RECEIPT_PROVIDER", undefined],
    ["provider unsupported", "RECEIPT_PROVIDER", "azure-document-intelligence"],
    ["provider version absent", "RECEIPT_PROVIDER_VERSION", undefined],
    ["provider version unsupported", "RECEIPT_PROVIDER_VERSION", "gemini-latest"],
    ["region absent", "RECEIPT_PROVIDER_REGION", undefined],
    ["region invalid", "RECEIPT_PROVIDER_REGION", "region with spaces"],
    ["retention absent", "RECEIPT_PROVIDER_RETENTION_HOURS", undefined],
    ["retention above contract", "RECEIPT_PROVIDER_RETENTION_HOURS", "25"],
    ["resource limit absent", "RECEIPT_PROVIDER_MONTHLY_UNIT_LIMIT", undefined],
    ["resource limit zero", "RECEIPT_PROVIDER_MONTHLY_UNIT_LIMIT", "0"],
    ["resource limit negative", "RECEIPT_PROVIDER_MONTHLY_UNIT_LIMIT", "-1"],
    ["resource limit over Phase 1 cap", "RECEIPT_PROVIDER_MONTHLY_UNIT_LIMIT", "101"],
    ["resource limit fractional", "RECEIPT_PROVIDER_MONTHLY_UNIT_LIMIT", "1.5"],
    ["business limit zero", "RECEIPT_PROVIDER_BUSINESS_MONTHLY_UNIT_LIMIT", "0"],
    ["business limit over Phase 1 cap", "RECEIPT_PROVIDER_BUSINESS_MONTHLY_UNIT_LIMIT", "101"],
    ["credential absent", "GOOGLE_GEMINI_API_KEY", undefined],
  ])("fails closed when %s", (_label, key, value) => {
    const source = operationalGeminiEnv();
    if (value === undefined) delete source[key];
    else source[key] = value;

    const config = getReceiptProviderConfiguration(source);
    expect(config.operational).toBe(false);
    expect(publicReceiptProviderDetails(config)).toBeNull();
  });

  it("defaults routing to rescue and consent to explicit when the settings are absent or unknown", () => {
    const absent = getReceiptProviderConfiguration(operationalGeminiEnv());
    expect(absent).toMatchObject({ operational: true, routing: "rescue", consentMode: "explicit" });

    for (const value of ["ALWAYS", "Always", " always", "true", "1", "", "automatic", "rescue "]) {
      const config = getReceiptProviderConfiguration({ ...operationalGeminiEnv(), RECEIPT_PROVIDER_ROUTING: value });
      expect(config.routing, `routing=${JSON.stringify(value)}`).toBe("rescue");
    }
    for (const value of ["AUTOMATIC", "Automatic", " automatic", "true", "1", "", "always", "explicit "]) {
      const config = getReceiptProviderConfiguration({ ...operationalGeminiEnv(), RECEIPT_PROVIDER_CONSENT_MODE: value });
      expect(config.consentMode, `consentMode=${JSON.stringify(value)}`).toBe("explicit");
    }
  });

  it("accepts the exact opt-in values without changing the operational gate", () => {
    const optedIn = getReceiptProviderConfiguration({
      ...operationalGeminiEnv(),
      RECEIPT_PROVIDER_ROUTING: "always",
      RECEIPT_PROVIDER_CONSENT_MODE: "automatic",
    });
    expect(optedIn).toMatchObject({ operational: true, routing: "always", consentMode: "automatic" });

    const disabled = getReceiptProviderConfiguration({
      RECEIPT_PROVIDER_ROUTING: "always",
      RECEIPT_PROVIDER_CONSENT_MODE: "automatic",
    });
    expect(disabled).toMatchObject({ operational: false, routing: "always", consentMode: "automatic" });
    expect(publicReceiptProviderDetails(disabled)).toBeNull();
  });

  it("requires all four Veryfi credentials and the exact configured version", () => {
    const source: NodeJS.ProcessEnv = {
      ...operationalGeminiEnv(),
      RECEIPT_PROVIDER: "veryfi",
      RECEIPT_PROVIDER_VERSION: "receipt-api-v8",
      RECEIPT_PROVIDER_REGION: "us",
      VERYFI_CLIENT_ID: "mocked-client",
      VERYFI_CLIENT_SECRET: "mocked-secret",
      VERYFI_USERNAME: "mocked-user",
      VERYFI_API_KEY: "mocked-key",
    };
    delete source.GOOGLE_GEMINI_API_KEY;

    expect(getReceiptProviderConfiguration(source)).toMatchObject({
      operational: true,
      provider: "veryfi",
      unitType: "PAGE",
    });
    for (const key of ["VERYFI_CLIENT_ID", "VERYFI_CLIENT_SECRET", "VERYFI_USERNAME", "VERYFI_API_KEY"]) {
      const incomplete = { ...source };
      delete incomplete[key];
      expect(getReceiptProviderConfiguration(incomplete).operational, key).toBe(false);
    }
  });
});

/*
 * The gate's budget used to be one provider HTTP call's deadline. Gemini's
 * adapter makes two of those in series (extract, then a second model verifies
 * the answer), so a 12s extraction followed by a 9s verification was aborted
 * as PROVIDER_TIMEOUT at 20s — after both calls had been billed and after the
 * answer had arrived. The budget has to cover what a healthy adapter can
 * legitimately spend, or the gate destroys the thing it is protecting.
 */
describe("provider gate timeout budget", () => {
  it("covers both of Gemini's sequential calls, with room around them", () => {
    const gemini = receiptProviderGateTimeoutMs("gemini");

    expect(gemini).toBeGreaterThan(2 * RECEIPT_PROVIDER_TIMEOUT_MS);
    expect(gemini).toBe(45_000);
  });

  it("does not inflate Veryfi, whose per-page calls run concurrently", () => {
    const veryfi = receiptProviderGateTimeoutMs("veryfi");

    expect(veryfi).toBeGreaterThan(RECEIPT_PROVIDER_TIMEOUT_MS);
    expect(veryfi).toBeLessThan(receiptProviderGateTimeoutMs("gemini"));
  });

  it("is what the configuration hands the gate, alongside the per-call deadline", () => {
    const config = getReceiptProviderConfiguration(operationalGeminiEnv());

    // Both values are needed and they are not the same number: the per-call
    // one is what the provider is asked for and what the contract records.
    expect(config.timeoutMs).toBe(RECEIPT_PROVIDER_TIMEOUT_MS);
    expect(config.gateTimeoutMs).toBe(receiptProviderGateTimeoutMs("gemini"));
  });
});
