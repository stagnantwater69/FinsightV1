import { describe, expect, it } from "vitest";
import { evidence, localExtraction } from "../helpers/receiptProviderFixtures";
import { localCorroborationFrom } from "../../src/services/receiptProviderContract";

/* What the local read may offer as already checked, so the verifier can be skipped. */
describe("localCorroborationFrom", () => {
  it("offers a date and total the local read validated", () => {
    expect(localCorroborationFrom(localExtraction())).toEqual({ date: "2026-09-13", total: 100 });
  });

  it("offers nothing when the date is unchecked, for example locale-ambiguous", () => {
    const unchecked = evidence("local-tesseract", { validationState: "UNVALIDATED", confidenceBand: "LOW" });
    expect(localCorroborationFrom(localExtraction({ date: { value: "2026-09-03", evidence: unchecked } }))).toBeNull();
  });

  it("offers nothing when the total is unchecked, for example the lines do not add up", () => {
    const unchecked = evidence("local-tesseract", { validationState: "UNVALIDATED", confidenceBand: "LOW" });
    expect(localCorroborationFrom(localExtraction({ total: { value: 100, evidence: unchecked } }))).toBeNull();
  });

  it("offers nothing when either value is missing", () => {
    expect(localCorroborationFrom(localExtraction({ total: { value: null, evidence: null } }))).toBeNull();
    expect(localCorroborationFrom(localExtraction({ date: { value: null, evidence: null } }))).toBeNull();
  });

  it("never treats a provider value as the local read's own", () => {
    const fromProvider = evidence("gemini");
    expect(localCorroborationFrom(localExtraction({ total: { value: 100, evidence: fromProvider } }))).toBeNull();
  });
});
