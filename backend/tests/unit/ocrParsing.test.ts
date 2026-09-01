import { describe, expect, it } from "vitest";
import { parseReceiptFields } from "../../src/services/ocr.service";

// Parser-level tests. These take OCR text as INPUT, so they are fast and
// deterministic — no images, no tesseract. Real end-to-end accuracy against
// images is measured separately by tests/ocr-accuracy/run-assessment.ts.

const receipt = (lines: string[]) => parseReceiptFields(lines.join("\n"));

describe("date parsing", () => {
  it("reads an ISO date", () => {
    expect(receipt(["MY STORE", "Date: 2026-07-20", "TOTAL 100.00"]).date).toBe("2026-07-20");
  });

  it("reads a month-name date", () => {
    expect(receipt(["MY STORE", "Jul 05, 2026", "TOTAL 100.00"]).date).toBe("2026-07-05");
    expect(receipt(["MY STORE", "July 5 2026", "TOTAL 100.00"]).date).toBe("2026-07-05");
  });

  it("reads a two-digit year", () => {
    expect(receipt(["MY STORE", "Date: 07/22/26", "TOTAL 100.00"]).date).toBe("2026-07-22");
  });

  it("assumes DD/MM when both components are ambiguous (Philippine convention)", () => {
    // 03/09 -> 3 September, not 9 March. Genuinely unresolvable without a
    // locale; DD/MM is the convention in the target market.
    expect(receipt(["MY STORE", "Date: 03/09/2026", "TOTAL 100.00"]).date).toBe("2026-09-03");
  });

  // REGRESSION: the MM/DD default read a real Cebu receipt exactly wrong.
  // "11/07/2026" is 11 July there, not 7 November.
  it("reads an ambiguous date the Philippine way round", () => {
    expect(receipt(["SOME STORE", "11/07/2026 11:04", "TOTAL 188.00"]).date).toBe("2026-07-11");
  });

  it("still resolves by validity when only one reading is possible", () => {
    // Second component > 12 -> it must be the day, so MM/DD regardless of the
    // DD/MM default.
    expect(receipt(["MY STORE", "Date: 07/22/2026", "TOTAL 100.00"]).date).toBe("2026-07-22");
    // First component > 12 -> it must be the day.
    expect(receipt(["MY STORE", "Date: 25/07/2026", "TOTAL 100.00"]).date).toBe("2026-07-25");
  });

  // ===================================================================
  // REGRESSION: invalid dates crashed the entire receipt upload.
  // ===================================================================
  // A DD/MM/YYYY receipt dated after the 12th produced "2026-25-07" (month 25).
  // That string becomes an Invalid Date, Prisma rejects it with a validation
  // error, and the whole upload failed with a 500 — so the owner lost the scan
  // instead of getting a correctable draft. DD/MM/YYYY is the common Philippine
  // format, so this hit the target market directly.
  it("resolves DD/MM/YYYY when the first component cannot be a month", () => {
    expect(receipt(["MANDAUE DRY GOODS", "Date: 25/07/2026", "TOTAL 1875.00"]).date).toBe("2026-07-25");
  });

  it("never emits a structurally impossible date", () => {
    for (const line of ["Date: 25/07/2026", "Date: 31/12/2026", "Date: 2026-13-45", "Date: 99/99/2026"]) {
      const parsed = receipt(["MY STORE", line, "TOTAL 100.00"]);
      if (parsed.date !== null) {
        expect(Number.isNaN(new Date(parsed.date).getTime()), `${line} -> ${parsed.date}`).toBe(false);
        expect(parsed.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
    }
  });

  it("rejects a day that does not exist in that month", () => {
    // 31 February would silently roll over to 2 or 3 March without the
    // round-trip validity check.
    expect(receipt(["MY STORE", "Date: 2026-02-31", "TOTAL 100.00"]).date).not.toBe("2026-02-31");
  });

  it("returns null rather than a guess when there is no date at all", () => {
    expect(receipt(["MY STORE", "TOTAL 100.00"]).date).toBeNull();
  });

  // ===================================================================
  // REGRESSION: administrative dates were picked over the transaction date.
  // ===================================================================
  // Philippine POS receipts print BIR permit and accreditation dates, usually
  // ABOVE the transaction date. First-match-wins read those instead: a real
  // receipt returned 2024-10-14 from its "PTU Issued" line.
  it("ignores a PTU-issued date in favour of the transaction date", () => {
    expect(
      receipt([
        "SOME STORE",
        "PTU Issued: 10/14/2024",
        "Date: 2026-07-11",
        "TOTAL 188.00",
      ]).date
    ).toBe("2026-07-11");
  });

  it("ignores permit, accreditation and valid-until dates", () => {
    expect(
      receipt([
        "SOME STORE",
        "Permit No: FP102024-080-0473287",
        "Accreditation: 080-000069987 valid until 07/31/25",
        "Date Issued: 08/01/2020",
        "Date: 2026-07-11",
        "TOTAL 188.00",
      ]).date
    ).toBe("2026-07-11");
  });

  it("falls back to an administrative date rather than returning nothing", () => {
    // A wrong-but-plausible date the owner can correct beats an empty field.
    expect(receipt(["SOME STORE", "PTU Issued: 10/14/2024", "TOTAL 188.00"]).date).toBe("2024-10-14");
  });
});

describe("amount parsing", () => {
  it("prefers the TOTAL line", () => {
    expect(receipt(["MY STORE", "Item 5000.00", "TOTAL 1220.00"]).amount).toBe(1220);
  });

  it("ignores SUBTOTAL when a TOTAL exists", () => {
    expect(receipt(["MY STORE", "SUBTOTAL 1000.00", "VAT 120.00", "TOTAL 1120.00"]).amount).toBe(1120);
  });

  // REGRESSION: \d{1,3} before the optional comma groups truncated a plain 4+
  // digit total, so "1220.00" was read as "220.00".
  it("does not truncate a 4+ digit total with no thousands separator", () => {
    expect(receipt(["MY STORE", "TOTAL 1220.00"]).amount).toBe(1220);
    expect(receipt(["MY STORE", "TOTAL 12500.00"]).amount).toBe(12500);
    expect(receipt(["MY STORE", "TOTAL 123456.789"]).amount).not.toBe(456.78);
  });

  it("reads a thousands separator", () => {
    expect(receipt(["MY STORE", "TOTAL 12,450.00"]).amount).toBe(12450);
    expect(receipt(["MY STORE", "TOTAL 1,234,567.00"]).amount).toBe(1234567);
  });

  it("falls back to the largest money-shaped number when there is no TOTAL line", () => {
    expect(receipt(["MY STORE", "Amount Due 3400.00", "Item 1200.00"]).amount).toBe(3400);
  });

  it("handles a small amount", () => {
    expect(receipt(["MY STORE", "TOTAL 8.50"]).amount).toBe(8.5);
  });

  it("returns null when there is no money-shaped number", () => {
    expect(receipt(["MY STORE", "no amounts here"]).amount).toBeNull();
  });

  // REGRESSION (real-33-mcdonalds-my-combo-submenu, real image corpus). The
  // header "QTY ITEM TOTAL" matched the total keyword but carried no money,
  // and the old code bailed out there instead of trying the next
  // total-shaped line — falling through to the max-value fallback, where
  // "Cash tendered 50.00" won over the real 19.00 total.
  it("keeps looking past a total-shaped line with no money before falling back to tender/change", () => {
    const parsed = receipt([
      "QTY ITEM TOTAL",
      "2 M McChicken 19.00",
      "TakeOut Total (incl GST) 19.00",
      "Cash tendered 50.00",
      "Change 31.00",
    ]);
    expect(parsed.amount).toBe(19);
  });

  // REGRESSION (real-33 and real-35 in the real image corpus). A tax
  // breakdown annotation stating the GST/VAT PORTION, not the amount paid,
  // shares a line with the word "total" and used to win by being read first.
  it("does not treat a tax-inclusive breakdown note as the total", () => {
    expect(
      receipt(["Item 1 19.00", "TakeOut Total (incl GST) 19.00", "TOTAL INCLUDES 6% GST 1.08"]).amount,
    ).toBe(19);
    expect(receipt(["Item 1 25.15", "Total 25.15", "(Total Included GST @ 6% : 1.42)"]).amount).toBe(25.15);
  });

  // REGRESSION (real-38-super-seven-dot-noise-duplicate-lines, real image
  // corpus). A GST receipt printed a pre-rounding "Total Sales" figure
  // before the post-rounding "Net Total" the owner actually paid, and
  // first-match-wins picked the earlier, pre-rounding one.
  it("prefers a Net Total line over an earlier pre-rounding Total Sales line", () => {
    expect(
      receipt(["Total Sales (Incl. GST @6%) RM18.29", "Rounding Adjustment RM0.01", "Net Total RM18.30"]).amount,
    ).toBe(18.3);
  });

  // REGRESSION (real-37-gardenia-torn-multi-subtotal, real image corpus). A
  // multi-tier VAT invoice prints several intermediate "Total X% supplies"
  // breakdown lines before the actual "Total Payable" line, and first-match
  // picked the first (zero-rated) subtotal instead of the payable figure.
  it("prefers Total Payable over intermediate multi-tier VAT subtotal lines", () => {
    const parsed = receipt([
      "Total 0% supplies: 18.92",
      "Total 6% supplies (excl. GST): 56.93",
      "Total 6% supplies (Inc. GST): 60.34",
      "Total 0% supplies: 13.92",
      "Total Payable: 79.26",
    ]);
    expect(parsed.amount).toBe(79.26);
  });
});

describe("vendor parsing", () => {
  it("reads a vendor at the top", () => {
    expect(receipt(["ALING NENA SARI-SARI STORE", "Apas, Cebu City", "TOTAL 100.00"]).vendor).toBe(
      "ALING NENA SARI-SARI STORE"
    );
  });

  // REGRESSION: registration blocks above the store name were read as the
  // vendor. A real receipt returned "VAT REG TIN: 123-456-789-00000".
  it("skips a registration/permit block above the store name", () => {
    expect(
      receipt([
        "VAT REG TIN: 123-456-789-00000",
        "PERMIT NO: FP102026-080-0473287",
        "POS SN: 1000104650067",
        "LAPU-LAPU TRADING CO",
        "Date: 2026-07-21",
        "TOTAL 5600.00",
      ]).vendor
    ).toBe("LAPU-LAPU TRADING CO");
  });

  it("skips a bare document header", () => {
    expect(receipt(["*** SALES INVOICE ***", "CEBU MINI GROCERY", "TOTAL 100.00"]).vendor).toBe("CEBU MINI GROCERY");
  });

  it("skips a line that is mostly digits", () => {
    expect(receipt(["1000104650067", "REAL STORE NAME", "TOTAL 100.00"]).vendor).toBe("REAL STORE NAME");
  });

  it("still returns something rather than nothing when every line looks administrative", () => {
    // Better a wrong draft the owner corrects than a blank field.
    const parsed = receipt(["VAT REG TIN: 123-456-789", "TOTAL 100.00"]);
    expect(parsed.vendor).not.toBeNull();
  });

  /*
   * WAS a known limitation, now fixed by scoring candidates instead of taking
   * the first one. A footer store name used to lose to whatever appeared
   * above it; it now wins on the strength of reading like a business name
   * while the lines above are an invoice header, a date and a purchase.
   *
   * Position still counts — this is not a promise that the footer always
   * wins, only that being lower down no longer disqualifies a real name.
   */
  it("finds a store name printed in the footer", () => {
    const parsed = receipt([
      "*** SALES INVOICE ***",
      "Date: 2026-07-18",
      "Softdrinks case 540.00",
      "TOTAL 845.50",
      "TINDAHAN NI MANG JOSE",
      "Thank you, come again!",
    ]);
    expect(parsed.vendor).toBe("TINDAHAN NI MANG JOSE");
  });
});

describe("description", () => {
  it("derives a description from the vendor", () => {
    expect(receipt(["MY STORE", "TOTAL 100.00"]).description).toBe("Purchase from MY STORE");
  });

  it("falls back to a generic description when no vendor is readable", () => {
    expect(receipt(["", "  "]).description).toBe("Receipt purchase");
  });
});

// ============================================================
// Vendor selection — scored, not first-past-the-post
// ============================================================
// REGRESSION, from a real Savemore receipt photographed on a phone: tesseract
// made a 4-letter smudge ("Dore") out of the stylised wordmark above the
// store name, and taking the first substantive line meant that smudge beat the
// real business name printed three lines below it.

describe("choosing the vendor among several header lines", () => {
  it("prefers a real business name over a short logo smudge above it", () => {
    const parsed = receipt([
      "Dore",
      "BASAK",
      "SANFORD MARKETING CORPORATION",
      "SAVEMORE MARKET BASAK #31 JP RIZAL ST",
      "TOTAL DUE  PHP 689.75",
    ]);
    expect(parsed.vendor).not.toBe("Dore");
    expect(parsed.vendor).toMatch(/MARKET/i);
  });

  /** An item line is a purchase, not a shop name, however business-y it reads. */
  it("never picks a line that ends in a money amount", () => {
    const parsed = receipt(["ALING NENA STORE", "Cleaning supplies 675.00", "TOTAL 675.00"]);
    expect(parsed.vendor).toBe("ALING NENA STORE");
  });

  /**
   * "BARANGAY SUPPLY DEPOT" is a shop whose name starts with a word that also
   * appears in addresses. Penalising address words flatly cost this vendor,
   * so the penalty is skipped when the line already reads as a business.
   */
  it("keeps a business name that happens to contain an address word", () => {
    const parsed = receipt(["BARANGAY SUPPLY DEPOT", "Jul 05, 2026", "Cleaning supplies 675.00", "TOTAL 675.00"]);
    expect(parsed.vendor).toBe("BARANGAY SUPPLY DEPOT");
  });

  it("still finds a plain vendor with no keyword at all", () => {
    expect(receipt(["ALING NENA", "Date: 2026-07-20", "TOTAL 100.00"]).vendor).toBe("ALING NENA");
  });

  // REGRESSION (real-33-mcdonalds-my-combo-submenu, real image corpus). A
  // customer-service phone line read as a business-type phrase ("center" is a
  // VENDOR_KEYWORD) and outscored "McDonald's" a few lines above it.
  it("skips a customer-service phone line", () => {
    const parsed = receipt([
      "McDonald's Steli Mahkota Cheras DT (4736",
      "TAX INVOICE",
      "2 M McChicken 19.00",
      "Total (incl GST) 19.00",
      "Guest Relations Center : 1300-13-1300",
    ]);
    expect(parsed.vendor).toMatch(/McDonald/i);
  });

  // REGRESSION (real-29-saska-paperclip-clipboard, real image corpus). A
  // garbled "before discounts" gratuity-table header outscored "SASKA'S" a
  // few lines above it, and an address line ("... Mission Blvd") separately
  // outscored it once the gratuity line was excluded — "Blvd" was missing
  // from the address-word penalty list.
  it("skips suggested-gratuity boilerplate and a Blvd address line", () => {
    const parsed = receipt([
      "SASKA'S",
      "3788 Mission Blvd",
      "Draft Blackhouse 7.00",
      "Total 179.94",
      "SUGGESTED TIP",
      "i BEFORE DISCOUNTS A",
      "18% =$30.06",
    ]);
    expect(parsed.vendor).toBe("SASKA'S");
  });

  // REGRESSION (real-28-carls-jr-translucent-bleed, real image corpus). A
  // store-ID footer line ("i Restaurant 1100580 i") scored higher than the
  // real name above it purely on the strength of the generic business-type
  // word "Restaurant" plus its length. Gated on word count so a genuine
  // business name that happens to carry a registration number (below) keeps
  // scoring on its own merits.
  it("skips a store-ID footer line but keeps a name with a registration number", () => {
    const parsed = receipt(["CARL'S JR", "i Restaurant 1100580 i", "11961 Beach Blvd.", "Total 1.61"]);
    expect(parsed.vendor).toBe("CARL'S JR");

    const withRegNumber = receipt([
      "KING'S CONFECTIONERY S/B 273500-U (KSB)",
      "NO.41, JALAN SERI BINTANG 2",
      "Total 25.15",
    ]);
    expect(withRegNumber.vendor).toMatch(/KING'S CONFECTIONERY/i);
  });

  // REGRESSION (real-37-gardenia-torn-multi-subtotal, real image corpus). The
  // recipient/client's name printed further down the invoice outscored the
  // issuing vendor's own name at the top — "BAKERIES" (plural) did not match
  // the singular-only "bakery" keyword, so the real vendor lost its strongest
  // signal.
  it("prefers the issuing vendor at the top over a recipient block further down", () => {
    // Position matters to the scoring, so this keeps the same line COUNT
    // before the recipient block as the real receipt it is pinned to.
    const parsed = receipt([
      "GARDENIA BAKERIES (KL) SDN BHD (139386 X)",
      "Lot 3, Jalan Pelabur 23/1,",
      "40300 Shah Alam, Selangor.",
      "Tel: 03-55423228",
      "GST ID: 000351399040",
      "TAX INVOICE",
      "Cash Inv No.: 7922F711",
      "Date: 22/09/2017",
      "MAb noonR FRESH MARKET SON BHD",
      "GROUND FLOOR, NO. 4 & 6,",
      "Total Payable: 79.26",
    ]);
    expect(parsed.vendor).toMatch(/GARDENIA/i);
  });
});
