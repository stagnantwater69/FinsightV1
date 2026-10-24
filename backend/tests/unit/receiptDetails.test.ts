import { describe, expect, it } from "vitest";
import { parseReceiptDetails } from "../../src/lib/receiptDetails";

describe("printed receipt details", () => {
  it("extracts labelled details without storing card digits or changing the total", () => {
    expect(parseReceiptDetails([
      "Receipt No: INV-007", "Date: 2026-09-10 Time: 01:24:08 PM", "Subtotal PHP 1,000.00",
      "VAT (12%) 120.00", "Tip: 20.00", "Discount: -10.00", "TOTAL PHP 1,130.00", "Payment: Visa **** 1234",
    ].join("\n"))).toEqual({ currency: "PHP", transactionTime: "13:24:08", subtotal: 1000,
      tax: 120, tip: 20, discount: 10, paymentMethod: "Visa", receiptNumber: "INV-007" });
  });

  it("keeps missing values null and never treats total or suggested tips as extracted details", () => {
    const { currency, ...details } = parseReceiptDetails("TOTAL $100.00\nSuggested tip\nTip: 15.00\nVAT included\nCashier 1234");
    expect(currency).toBe("PHP");
    expect(Object.values(details)).toEqual(Array(7).fill(null));
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

describe("receipt currency", () => {
  it("reads every receipt as pesos, whatever marks OCR finds on it", () => {
    // The noisy lines are tesseract's own, from a four-photo La Nueva receipt
    // that prints no "P" anywhere: an 8 read as "£", "GUM 50s/40" as "EUR 50s/40".
    const laNueva = [
      "LA NUEVA SUPERMART INC.", "1 £8.80  88.80V", "VERESH COOL EUR 50s/40", ": 1 61.55 &£1.55Y", "Total Amount: 6,825.20",
    ].join("\n");
    for (const text of [laNueva, "TOTAL USD 112.00", "TOTAL $12.00", "TOTAL ¥1200", "Total P7967 .25", ""]) {
      expect(parseReceiptDetails(text).currency).toBe("PHP");
    }
    expect(parseReceiptDetails(null).currency).toBe("PHP");
  });
});
