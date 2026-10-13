import { describe, expect, it } from "vitest";
import {
  parseReceiptDetails,
  providerReportedCurrency,
  requiresManualCurrencyConversion,
} from "../../src/lib/receiptDetails";

describe("printed receipt details", () => {
  it("extracts labelled details without storing card digits or changing the total", () => {
    expect(parseReceiptDetails([
      "Receipt No: INV-007", "Date: 2026-09-10 Time: 01:24:08 PM", "Subtotal PHP 1,000.00",
      "VAT (12%) 120.00", "Tip: 20.00", "Discount: -10.00", "TOTAL PHP 1,130.00", "Payment: Visa **** 1234",
    ].join("\n"))).toEqual({ currency: "PHP", transactionTime: "13:24:08", subtotal: 1000,
      tax: 120, tip: 20, discount: 10, paymentMethod: "Visa", receiptNumber: "INV-007" });
  });

  it("keeps missing values null and never treats total or suggested tips as extracted details", () => {
    const details = parseReceiptDetails("TOTAL $100.00\nSuggested tip\nTip: 15.00\nVAT included\nCashier 1234");
    expect(Object.values(details)).toEqual(Array(8).fill(null));
  });

  it.each(["USD 12.00", "Total 12.00 USD", "Currency: USD", "Total US$12.00"])("recognises explicit foreign currency: %s", (text) => {
    expect(parseReceiptDetails(text).currency).toBe("USD");
  });

  it("does not infer a currency from a bare dollar or yen sign or conflicting codes", () => {
    for (const text of ["TOTAL $12.00", "TOTAL ¥1200", "TOTAL PHP 500.00\nTOTAL USD 10.00"]) {
      expect(parseReceiptDetails(text).currency).toBeNull();
    }
    expect(requiresManualCurrencyConversion("TOTAL PHP 500.00\nTOTAL USD 10.00")).toBe(true);
    expect(requiresManualCurrencyConversion("TOTAL $10.00")).toBe(true);
    expect(requiresManualCurrencyConversion("TOTAL ¥1200")).toBe(true);
    expect(requiresManualCurrencyConversion("TOTAL ￥1200")).toBe(true);
    // Dollar amounts on more than one line of a peso receipt: mixed, so refused.
    expect(requiresManualCurrencyConversion("TOTAL PHP 500.00\nCash $10.00\nChange $2.00")).toBe(true);
    expect(requiresManualCurrencyConversion("TOTAL PHP 500.00")).toBe(false);
  });

  it("reads a peso receipt as PHP and ignores a stray symbol that is not on an amount", () => {
    // OCR of a Robinsons logo: "£0" is noise in the header, the money is printed as "P938.00".
    const robinsons = "hs w— . of £0\nCHARMEE AN LONG 10S 62.00 V\nTOTAL P62 .00\nCASH P1,000.00\nChange P938.00";
    expect(parseReceiptDetails(robinsons).currency).toBe("PHP");
    expect(requiresManualCurrencyConversion(robinsons)).toBe(false);
    expect(parseReceiptDetails("Total ₱ 62.00").currency).toBe("PHP");
    expect(requiresManualCurrencyConversion("**** $ ****\nTOTAL P62.00")).toBe(false);
    // A right-aligned column puts several spaces between symbol and figure,
    // and that is still one printed amount.
    expect(requiresManualCurrencyConversion("TOTAL US$   12.50")).toBe(true);
    expect(requiresManualCurrencyConversion("TOTAL:   $   45.20")).toBe(true);
    expect(parseReceiptDetails("TOTAL US$   12.50").currency).toBe("USD");
    // But a symbol and a figure on different lines are not.
    expect(requiresManualCurrencyConversion("SUBTOTAL $\n62.00")).toBe(false);
    // A symbol on an amount still counts.
    expect(parseReceiptDetails("TOTAL £12.50").currency).toBe("GBP");
    expect(requiresManualCurrencyConversion("TOTAL £12.50")).toBe(true);
    expect(parseReceiptDetails("TOTAL €12.50").currency).toBe("EUR");
  });

  it("does not guess between conflicting labelled values or payment methods", () => {
    const details = parseReceiptDetails("Subtotal 10.00\nSubtotal 20.00\nCash 10.00\nVisa 10.00\nReceipt # A1\nReceipt # A2");
    expect(details.subtotal).toBeNull();
    expect(details.paymentMethod).toBeNull();
    expect(details.receiptNumber).toBeNull();
  });

  it("supports printed comma decimals and rejects invalid or opening-hour times", () => {
    const details = parseReceiptDetails("Subtotal EUR 1.234,50\nHours 08:00 to 17:00\nTime 25:60\nTime 12:05 AM");
    expect(details.subtotal).toBe(1234.5);
    expect(details.currency).toBe("EUR");
    expect(details.transactionTime).toBe("00:05");
  });

  it("rejects misleading amount labels, cash discount labels, and conflicting times", () => {
    const details = parseReceiptDetails("Subtotal savings 12.00\nDiscount code 10.00\nCash discount 10.00\nTime 10:30\nTime 11:30");
    expect(details.subtotal).toBeNull();
    expect(details.discount).toBeNull();
    expect(details.paymentMethod).toBeNull();
    expect(details.transactionTime).toBeNull();
    expect(parseReceiptDetails("Subtotal 1.2.34").subtotal).toBeNull();
    expect(parseReceiptDetails("Subtotal 1.234.50").subtotal).toBeNull();
  });
});

describe("provider-reported currency", () => {
  it("refuses a peso booking when only the provider could read the currency", () => {
    expect(requiresManualCurrencyConversion("Total 12.50")).toBe(false);
    expect(requiresManualCurrencyConversion("Total 12.50", "USD")).toBe(true);
  });

  it("does not let a provider PHP answer clear a refusal the printed text earned", () => {
    expect(requiresManualCurrencyConversion("Total US$ 12.50", "PHP")).toBe(true);
  });

  it("reads the code off extractorVersions and ignores anything that is not one", () => {
    expect(providerReportedCurrency({ providerCurrency: "USD" })).toBe("USD");
    expect(providerReportedCurrency({ providerCurrency: "us dollars" })).toBeNull();
    expect(providerReportedCurrency({ providerCurrency: null })).toBeNull();
    expect(providerReportedCurrency(null)).toBeNull();
    expect(providerReportedCurrency("USD")).toBeNull();
  });
});

describe("OCR noise on an itemised peso receipt", () => {
  const PESO_RECEIPT = ["005705486 1 115.25 115.25T", "FEMME BT300 2PLY 128+CTTN", "Total P7967.25", "VAT : P853.60"].join("\n");

  it("does not read a dollar sign on a serial number as a dollar amount", () => {
    // "#" read as "$" on a register serial line.
    const text = `Serial $6600441\n${PESO_RECEIPT}`;
    expect(requiresManualCurrencyConversion(text)).toBe(false);
    expect(parseReceiptDetails(text).currency).toBe("PHP");
  });

  it("does not read a dollar sign inside a product description as a dollar amount", () => {
    expect(requiresManualCurrencyConversion(`SUPER CRUNCH $WEETCORN 55\n${PESO_RECEIPT}`)).toBe(false);
  });

  it("does not pair a code ending one line with the figures that open the next", () => {
    const text = `GOLDEN TOWER ODONG CAD\n${PESO_RECEIPT}`;
    expect(requiresManualCurrencyConversion(text)).toBe(false);
    expect(parseReceiptDetails(text).currency).toBe("PHP");
  });

  /*
   * Measured, on the tesseract reading of the owner's own receipt: a red pen
   * stroke across the quantity column read as "¥", and the 8 of 80.00 as "£".
   * One mark on one item line of a receipt printed in pesos is noise.
   */
  it("does not read a pen stroke before a quantity as a yen amount", () => {
    const text = `005652850 ¥ 1 80.00 80.007\n${PESO_RECEIPT}`;
    expect(requiresManualCurrencyConversion(text)).toBe(false);
  });

  it("does not read one misread digit as a pound amount on a peso receipt", () => {
    const text = `005443303 2 £0.00 160.007\n${PESO_RECEIPT}`;
    expect(requiresManualCurrencyConversion(text)).toBe(false);
    expect(parseReceiptDetails(text).currency).toBe("PHP");
  });

  it("reads pesos through the space OCR puts before the decimal point", () => {
    expect(parseReceiptDetails("Total P7967 .25").currency).toBe("PHP");
  });

  it("still refuses a peso booking when the foreign amount is corroborated", () => {
    // On the line stating the total.
    expect(requiresManualCurrencyConversion("TOTAL $1,234.56")).toBe(true);
    // On two lines of the receipt.
    expect(requiresManualCurrencyConversion(`${PESO_RECEIPT}\nCash $10.00\nChange $2.00`)).toBe(true);
    // Or with nothing on the receipt saying pesos.
    expect(requiresManualCurrencyConversion("Coffee $3.50\nTOTAL 3.50")).toBe(true);
    expect(requiresManualCurrencyConversion("Ramen ¥980")).toBe(true);
  });
});
