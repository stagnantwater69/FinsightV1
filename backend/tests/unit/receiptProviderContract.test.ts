import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_EXTERNAL_PROVIDER_UNIT_LIMIT,
  mergeReceiptProviderOutcome,
  parseReceiptProviderRequest,
  validateReceiptProviderOutcome,
} from "../../src/services/receiptProviderContract";
import {
  evidence,
  localExtraction,
  providerRequest,
  successfulOutcome,
} from "../helpers/receiptProviderFixtures";

describe("receipt provider request contract", () => {
  it("defaults external provider capacity to zero", () => {
    expect(DEFAULT_EXTERNAL_PROVIDER_UNIT_LIMIT).toBe(0);
  });

  it.each([
    ["current consent", { consent: undefined }],
    ["reserved units", { reservation: undefined }],
    ["provider rescue decision", {
      rescueDecision: {
        version: "receipt-rescue-v1",
        providerRescueRequested: false,
        reviewLevel: "STANDARD",
        localResultDisposition: "PREFILL_FOR_REVIEW",
        reasons: [],
        calibration: { state: "CALIBRATED", version: "routing-v1" },
      },
    }],
    ["calibrated routing", {
      rescueDecision: {
        version: "receipt-rescue-v1",
        providerRescueRequested: false,
        reviewLevel: "FOCUSED",
        localResultDisposition: "PREFILL_FOR_REVIEW",
        reasons: ["MISSING_CRITICAL_TOTAL", "CALIBRATION_UNAVAILABLE"],
        calibration: { state: "UNCALIBRATED", version: null },
      },
    }],
  ])("rejects a request without %s", (_label, override) => {
    const valid = providerRequest();
    expect(() => parseReceiptProviderRequest({ ...valid, ...override })).toThrow();
  });

  it("rejects mismatched consent terms and insufficient page reservations", () => {
    const valid = providerRequest();
    expect(() => parseReceiptProviderRequest({
      ...valid,
      consent: { ...valid.consent, provider: "veryfi" },
    })).toThrow();
    expect(() => parseReceiptProviderRequest({
      ...valid,
      consent: { ...valid.consent, processingRegion: "other-region" },
    })).toThrow();
    expect(() => parseReceiptProviderRequest({
      ...valid,
      reservation: { ...valid.reservation, unitType: "PAGE", reservedUnits: 1 },
      pages: [valid.pages[0], { ...valid.pages[0], pageNumber: 2 }],
    })).toThrow();
    expect(() => parseReceiptProviderRequest({
      ...valid,
      pages: [{ ...valid.pages[0], dataClass: "DERIVED_RECEIPT_IMAGE" }],
      consent: { ...valid.consent, allowedDataClasses: ["RECEIPT_IMAGE"] },
    })).toThrow();
  });

  it("rejects duplicate page numbers, duplicate consent classes, and extra fields", () => {
    const valid = providerRequest();
    expect(() => parseReceiptProviderRequest({
      ...valid,
      pages: [valid.pages[0], { ...valid.pages[0] }],
    })).toThrow();
    expect(() => parseReceiptProviderRequest({
      ...valid,
      consent: { ...valid.consent, allowedDataClasses: ["RECEIPT_IMAGE", "RECEIPT_IMAGE"] },
    })).toThrow();
    expect(() => parseReceiptProviderRequest({ ...valid, receiptText: "must not enter provider contract" })).toThrow();
  });
});

describe("receipt provider outcome validation and merge", () => {
  it.each([
    ["provider", { provider: "veryfi" }, "METADATA_MISMATCH"],
    ["provider version", { providerVersion: "wrong-v1" }, "METADATA_MISMATCH"],
    ["region", { providerRegion: "wrong-region" }, "METADATA_MISMATCH"],
    ["dispatch reference", { dispatchReference: "dispatch:99" }, "METADATA_MISMATCH"],
    ["reserved-unit ceiling", { finalBillableUnits: 3 }, "UNIT_OVERAGE"],
    ["normalized schema version", {
      extraction: { ...successfulOutcome(providerRequest()).extraction!, schemaVersion: "normalized-v2" },
    }, "SCHEMA_VERSION_MISMATCH"],
    ["provider evidence source", {
      extraction: localExtraction({ schemaVersion: "normalized-v1" }),
    }, "EVIDENCE_SOURCE_MISMATCH"],
  ])("rejects an outcome with a mismatched %s", (_label, override, reason) => {
    const request = providerRequest();
    expect(validateReceiptProviderOutcome(request, successfulOutcome(request, override))).toEqual({ ok: false, reason });
  });

  it("keeps the local receipt when a provider outcome is invalid or unsuccessful", () => {
    const request = providerRequest();
    const local = localExtraction();

    expect(mergeReceiptProviderOutcome(local, request, { raw: "invalid" })).toEqual({
      receipt: local,
      appliedFields: [],
      providerResultAccepted: false,
      reason: "INVALID_OUTCOME",
    });
    expect(mergeReceiptProviderOutcome(local, request, {
      ...successfulOutcome(request),
      status: "FAILED",
      timeoutOutcome: "NOT_TIMED_OUT",
      outcomeCode: "TRANSPORT_ERROR",
      finalBillableUnits: 1,
      extraction: null,
    })).toMatchObject({
      receipt: local,
      appliedFields: [],
      providerResultAccepted: true,
      reason: "NOT_SUCCESSFUL",
    });
  });

  it.each([
    ["unvalidated", evidence("gemini", { validationState: "UNVALIDATED", confidenceBand: "LOW", sourceVersion: "provider-v1" })],
    ["weaker", evidence("gemini", { confidenceBand: "LOW", sourceVersion: "provider-v1" })],
    ["equal strength", evidence("gemini", { confidenceBand: "MEDIUM", sourceVersion: "provider-v1" })],
  ])("does not replace a validated local value with %s provider evidence", (_label, providerEvidence) => {
    const request = providerRequest();
    const local = localExtraction();
    const extraction = successfulOutcome(request).extraction!;
    const outcome = successfulOutcome(request, {
      extraction: { ...extraction, total: { value: 125, evidence: providerEvidence } },
    });

    const merged = mergeReceiptProviderOutcome(local, request, outcome);
    expect(merged.receipt.total).toEqual(local.total);
    expect(merged.appliedFields).not.toContain("total");
    expect(merged.reason).toBe("NO_SAFER_FIELDS");
  });

  it("uses a stronger validated provider field while retaining every safer local field", () => {
    const request = providerRequest();
    const local = localExtraction({
      total: {
        value: 100,
        evidence: evidence("local-tesseract", { confidenceBand: "LOW", sourceVersion: "tesseract-v1" }),
      },
    });
    const highProviderEvidence = evidence("gemini", {
      confidenceBand: "HIGH",
      calibrationState: "CALIBRATED",
      validationState: "VALIDATED",
      sourceVersion: "provider-v1",
    });
    const extraction = successfulOutcome(request).extraction!;
    const merged = mergeReceiptProviderOutcome(local, request, successfulOutcome(request, {
      extraction: { ...extraction, total: { value: 125, evidence: highProviderEvidence } },
    }));

    expect(merged.reason).toBe("MERGED");
    expect(merged.appliedFields).toEqual(["total"]);
    expect(merged.receipt.total).toEqual({ value: 125, evidence: highProviderEvidence });
    expect(merged.receipt.vendor).toEqual(local.vendor);
    expect(merged.receipt.source).toBe("merged");
  });

  it("does not replace local items unless the provider collection evidence is stronger and validated", () => {
    const request = providerRequest();
    const localItemEvidence = evidence("local-tesseract", { confidenceBand: "MEDIUM", sourceVersion: "tesseract-v1" });
    const local = localExtraction({
      items: [{ name: "Local item", quantity: 1, amount: 100, evidence: localItemEvidence }],
      itemsEvidence: localItemEvidence,
    });
    const providerItemEvidence = evidence("gemini", { confidenceBand: "LOW", sourceVersion: "provider-v1" });
    const extraction = successfulOutcome(request).extraction!;
    const result = mergeReceiptProviderOutcome(local, request, successfulOutcome(request, {
      extraction: {
        ...extraction,
        items: [{ name: "Provider item", quantity: 1, amount: 125, evidence: providerItemEvidence }],
        itemsEvidence: providerItemEvidence,
      },
    }));

    expect(result.receipt.items).toEqual(local.items);
    expect(result.appliedFields).not.toContain("items");
  });
});

describe("Phase 1 provider implementations", () => {
  it("ships no Azure network adapter or Azure client dependency", () => {
    const adapterSource = readFileSync(join(__dirname, "../../src/services/receiptScan/providerAdapters.ts"), "utf8");
    const packageJson = JSON.parse(readFileSync(join(__dirname, "../../package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const dependencyNames = Object.keys({ ...packageJson.dependencies, ...packageJson.devDependencies });

    expect(adapterSource).not.toMatch(/azure|document.?intelligence|form.?recognizer/i);
    expect(dependencyNames.some((name) => /azure.*(document|form)|@(azure)\/ai/i.test(name))).toBe(false);
  });
});
