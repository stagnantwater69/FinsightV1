import { describe, expect, it } from "vitest";
import { detectColumns, normaliseHeader } from "../../src/lib/csvColumnDetection";

function detect(headers: string[], rows: string[][], fileName?: string) {
  const records = rows.map((row) => Object.fromEntries(headers.map((header, index) => [header, row[index] ?? ""])));
  return detectColumns(headers, records, { fileName });
}

describe("normaliseHeader", () => {
  it("reduces snake_case, camelCase and currency suffixes to the same words", () => {
    expect(normaliseHeader("transaction_date")).toBe("transaction date");
    expect(normaliseHeader("transactionDate")).toBe("transaction date");
    expect(normaliseHeader("Amount (PHP)")).toBe("amount");
    expect(normaliseHeader("Txn-Date")).toBe("txn date");
  });
});

describe("detectColumns: headings", () => {
  it("maps the common alternative names without a mapping step", () => {
    const result = detect(
      ["transaction_date", "merchant", "description", "total"],
      [["2026-09-01", "National Book Store", "Printer Ink", "850"]],
    );
    expect(result.mapping).toEqual({
      date: "transaction_date",
      vendor: "merchant",
      description: "description",
      amount: "total",
    });
  });

  it.each([
    ["expense_date", "store", "item", "price"],
    ["purchase_date", "supplier", "product_name", "amount"],
    ["expenseDate", "vendorName", "itemDescription", "amountPaid"],
  ])("reads %s / %s / %s / %s", (date, vendor, description, amount) => {
    const result = detect([date, vendor, description, amount], [["2026-09-01", "NBS", "Ink", "850"]]);
    expect(result.mapping).toMatchObject({ date, vendor, description, amount });
  });

  it("prefers the total over the unit price and reports the rest as not imported", () => {
    const result = detect(
      ["Expense Date", "Supplier", "Item", "Qty", "Unit Price", "Amount (PHP)", "Category", "Ref No"],
      [["09/01/2026", "NBS", "Ink", "2", "425", "850", "Office Supplies", "OR-1"]],
    );
    expect(result.mapping).toMatchObject({ amount: "Amount (PHP)", category: "Category", description: "Item" });
    expect(result.unmapped).toEqual([
      { header: "Qty", field: "quantity" },
      { header: "Unit Price", field: "unitPrice" },
      { header: "Ref No", field: "reference" },
    ]);
  });

  it("uses a Notes column as the description only when nothing better exists", () => {
    const withDescription = detect(["Date", "Expense Description", "Amount", "Notes"], [["2026-09-01", "Ink", "850", "x"]]);
    expect(withDescription.mapping.description).toBe("Expense Description");
    expect(withDescription.unmapped).toEqual([{ header: "Notes", field: "notes" }]);
  });

  it("names payment method and reference columns instead of dropping them silently", () => {
    const result = detect(
      ["Date", "Description", "Amount", "Payment Method", "Transaction ID"],
      [["2026-09-01", "Ink", "850", "GCash", "TX-9"]],
    );
    expect(result.unmapped).toEqual([
      { header: "Payment Method", field: "paymentMethod" },
      { header: "Transaction ID", field: "reference" },
    ]);
  });

  it("reads Filipino headings", () => {
    const result = detect(["Petsa", "Detalye", "Halaga"], [["01/09/2026", "Bigas", "1200"]]);
    expect(result.mapping).toMatchObject({ date: "Petsa", amount: "Halaga", description: "Detalye" });
  });
});

describe("detectColumns: values must agree with headings", () => {
  it("does not take a text column as the date because its heading says 'posted'", () => {
    const result = detect(["Posted By", "When", "Item", "Amount"], [["Ana", "2026-09-01", "Ink", "850"]]);
    expect(result.mapping.date).toBe("When");
  });

  it("does not take a column of words as the amount because its heading says 'cost'", () => {
    const result = detect(["Date", "Item", "Cost Center", "Paid"], [["2026-09-01", "Ink", "Admin", "850"]]);
    expect(result.mapping.amount).toBe("Paid");
  });

  it("falls back on the values when no heading names the fields", () => {
    const result = detect(["A", "B", "C"], [
      ["2026-09-01", "Printer ink cartridge", "850"],
      ["2026-09-02", "Bond paper", "200"],
    ]);
    expect(result.mapping).toEqual({ date: "A", description: "B", amount: "C" });
  });
});

describe("detectColumns: sales or expenses", () => {
  it("suggests sales from sales headings and the file name", () => {
    const result = detect(["Date", "Product", "Quantity", "Revenue", "Customer"], [["2026-09-01", "Coffee", "2", "240", "Ana"]], "sales-sept.csv");
    expect(result.suggestedRecordType).toBe("sales");
    expect(result.mapping).toMatchObject({ description: "Product", amount: "Revenue" });
    expect(result.unmapped).toEqual([
      { header: "Quantity", field: "quantity" },
      { header: "Customer", field: "customer" },
    ]);
  });

  it("suggests expenses from supplier and category headings", () => {
    const result = detect(["Date", "Supplier", "Item", "Amount", "Category"], [["2026-09-01", "NBS", "Ink", "850", "Office"]]);
    expect(result.suggestedRecordType).toBe("expense");
  });

  it("says nothing when nothing hints either way", () => {
    expect(detect(["Date", "Item", "Amount"], [["2026-09-01", "Ink", "850"]]).suggestedRecordType).toBeNull();
  });
});
