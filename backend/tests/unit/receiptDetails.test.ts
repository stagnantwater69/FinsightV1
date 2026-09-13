import { describe, expect, it } from "vitest";
import { parseReceiptDetails, requiresManualCurrencyConversion } from "../../src/lib/receiptDetails";

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
    expect(requiresManualCurrencyConversion("TOTAL PHP 500.00\nCash $10.00")).toBe(true);
    expect(requiresManualCurrencyConversion("TOTAL PHP 500.00")).toBe(false);
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
