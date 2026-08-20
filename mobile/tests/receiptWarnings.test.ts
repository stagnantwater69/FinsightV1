import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import {
  RECEIPT_WARNING_CODES,
  evidenceSummary,
  fieldsNeedingAttention,
  warningHeadline,
  warningPageSuffix,
  warningTone,
  type ReceiptWarning,
} from "../src/lib/receiptWarnings";

/**
 * The warning contract, from the client's side.
 *
 * THE DEFECT THIS GUARDS: the app and the website each used to write their own
 * sentence for the same scan signals, and the two had already drifted apart.
 * The sentence is now the server's (`guidance`) and this lib holds only codes
 * and presentation — so the test that matters most is the one asserting no
 * prose is invented here.
 */

const BACKEND_WARNINGS = join(__dirname, "..", "..", "backend", "src", "lib", "receiptWarnings.ts");

function warning(overrides: Partial<ReceiptWarning> = {}): ReceiptWarning {
  return { code: "BLURRY_PAGE", guidance: "Hold the phone steady and retake this page.", ...overrides };
}

describe("the warning vocabulary", () => {
  /*
   * Read out of the server's own file rather than copied, because a code
   * added there and not here would otherwise fall through to the generic
   * headline silently — which looks like a working screen.
   */
  it("covers every code the server can emit", () => {
    const src = readFileSync(BACKEND_WARNINGS, "utf8");
    const block = src.slice(src.indexOf("export const WARNING_CODES"), src.indexOf("] as const"));
    const serverCodes = [...block.matchAll(/"([A-Z_]+)"/g)].map((m) => m[1]!);
    expect(serverCodes.length).toBeGreaterThan(5);
    expect([...RECEIPT_WARNING_CODES].sort()).toEqual([...serverCodes].sort());
  });

  it("has a headline for every code, and a safe one for a code it has never seen", () => {
    for (const code of RECEIPT_WARNING_CODES) {
      expect(warningHeadline(code).length).toBeGreaterThan(5);
    }
    expect(warningHeadline("SOMETHING_NEW")).toBe("FinSight flagged something on this receipt");
  });

  /*
   * OVERLAPPING_PAGES describes the capture overlap the multi-page guide ASKS
   * for. Warning an owner for following the instructions is how a warning
   * system loses its meaning.
   */
  it("does not raise an alarm about the overlap it asked for", () => {
    expect(warningTone("OVERLAPPING_PAGES")).toBe("info");
    expect(warningTone("BLURRY_PAGE")).toBe("warn");
    expect(warningTone("UNEXPLAINED_GAP")).toBe("warn");
  });

  it("names a page only when the warning is about one", () => {
    expect(warningPageSuffix(warning({ pageNumber: 2 }))).toBe(" (page 2)");
    expect(warningPageSuffix(warning())).toBe("");
  });
});

describe("which fields to point the owner at", () => {
  it("lists them in the order the review form presents them", () => {
    const warnings = [
      warning({ code: "UNREADABLE_FIELD", field: "amount" }),
      warning({ code: "AMBIGUOUS_DATE", field: "date" }),
      warning({ code: "UNREADABLE_FIELD", field: "vendor" }),
    ];
    expect(fieldsNeedingAttention(warnings)).toEqual(["date", "vendor", "amount"]);
  });

  it("normalises the server's field names onto the form's own", () => {
    expect(fieldsNeedingAttention([warning({ field: "extractedVendor" })])).toEqual(["vendor"]);
    expect(fieldsNeedingAttention([warning({ field: "total" })])).toEqual(["amount"]);
  });

  it("ignores a warning about no field in particular", () => {
    expect(fieldsNeedingAttention([warning()])).toEqual([]);
    expect(fieldsNeedingAttention([warning({ field: "something-else" })])).toEqual([]);
  });

  it("says each field once, however many warnings name it", () => {
    expect(
      fieldsNeedingAttention([warning({ field: "date" }), warning({ field: "date" })]),
    ).toEqual(["date"]);
  });
});

describe("field evidence", () => {
  it("quotes the line the value was read from", () => {
    expect(evidenceSummary({ pageNumber: 2, sourceText: "TOTAL 1,250.00", source: "ocr" })).toBe(
      'From page 2, read from the text: "TOTAL 1,250.00"',
    );
  });

  /*
   * Nulls are DROPPED, never printed. "From page unknown" is worse than
   * saying nothing — the whole point of evidence is that the owner can go and
   * look at it.
   */
  it("says only what is actually known", () => {
    expect(evidenceSummary({ pageNumber: 1, sourceText: null, source: null })).toBe("From page 1.");
    expect(evidenceSummary({ pageNumber: null, sourceText: "TOTAL 90", source: null })).toBe('From: "TOTAL 90"');
    expect(evidenceSummary({ pageNumber: null, sourceText: null, source: null })).toBeNull();
    expect(evidenceSummary(null)).toBeNull();
    expect(evidenceSummary(undefined)).toBeNull();
  });

  it("says when a value was interpreted rather than read", () => {
    expect(evidenceSummary({ pageNumber: 1, sourceText: null, source: "vision" })).toBe(
      "From page 1, interpreted from the photo.",
    );
  });
});
