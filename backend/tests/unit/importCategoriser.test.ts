import { describe, expect, it } from "vitest";
import { createImportCategoriser } from "../../src/lib/importCategoriser";

const categories = (...names: string[]) => names.map((name, index) => ({ id: index + 1, name }));

describe("importCategoriser: expenses with no category column", () => {
  it("files the prompt's examples under business categories", () => {
    const categoriser = createImportCategoriser({ categories: [], history: [], businessType: "Sari-sari store" });
    expect(categoriser.decide(undefined, "Printer Ink").name).toBe("Printing Supplies");
    expect(categoriser.decide(undefined, "Store Inventory").name).toBe("Inventory / Stock");
    expect(categoriser.decide(undefined, "Electricity Bill").name).toBe("Electricity and Utilities");
    expect(categoriser.decide(undefined, "Delivery Fuel").name).toBe("Fuel");
  });

  it("reuses the owner's existing category, including a broader one, before proposing a new one", () => {
    const categoriser = createImportCategoriser({
      categories: categories("Office Supplies", "Utilities", "Transportation"),
      history: [],
      businessType: "Consulting",
    });
    expect(categoriser.decide(undefined, "Printer Ink")).toMatchObject({ name: "Office Supplies", isNew: false, source: "suggested" });
    expect(categoriser.decide(undefined, "Electricity Bill")).toMatchObject({ name: "Utilities", isNew: false });
    expect(categoriser.decide(undefined, "Water bill")).toMatchObject({ name: "Utilities", isNew: false });
    expect(categoriser.decide(undefined, "Delivery Fuel")).toMatchObject({ name: "Transportation", isNew: false });
  });

  it("marks a proposed category as new, and proposes it once for many rows", () => {
    const categoriser = createImportCategoriser({ categories: [], history: [], businessType: null });
    const first = categoriser.decide(undefined, "Accountant fee");
    const second = categoriser.decide(undefined, "Bookkeeper monthly fee");
    expect(first).toMatchObject({ name: "Professional Services", isNew: true, confidence: "medium" });
    expect(second.name).toBe("Professional Services");
  });

  it("prefers the owner's own earlier choice for the same item", () => {
    const categoriser = createImportCategoriser({
      categories: categories("Kitchen", "Office Supplies"),
      history: [{ description: "Printer Ink", vendor: null, categoryId: 1, categoryName: "Kitchen" }],
      businessType: null,
    });
    expect(categoriser.decide(undefined, "printer ink")).toMatchObject({ name: "Kitchen", source: "history" });
  });

  it("keeps a clearly personal purchase personal for a business that does not sell it", () => {
    const categoriser = createImportCategoriser({ categories: [], history: [], businessType: "Consulting" });
    expect(categoriser.decide(undefined, "Groceries for home")).toMatchObject({ name: "Groceries", confidence: "low" });
  });

  it("files the same goods as stock for a shop that sells them", () => {
    const categoriser = createImportCategoriser({ categories: [], history: [], businessType: "Sari-sari store" });
    expect(categoriser.decide(undefined, "Coca-Cola 1.5L x 12").name).toBe("Inventory / Stock");
  });

  it("leaves an unreadable row uncategorised rather than guessing, reusing the owner's spelling", () => {
    const categoriser = createImportCategoriser({ categories: categories("Uncategorized"), history: [], businessType: null });
    expect(categoriser.decide(undefined, "zzq 4471")).toMatchObject({ name: "Uncategorized", source: "none", isNew: false });
    expect(categoriser.uncategorisedName).toBe("Uncategorized");
  });
});

describe("importCategoriser: a category the file or the owner named", () => {
  it("matches spelling variants to the existing category instead of creating a duplicate", () => {
    const categoriser = createImportCategoriser({ categories: categories("Office Supplies"), history: [], businessType: null });
    for (const raw of ["Office Supplies", "office supply", "Office Material", "Office Materials", "OFFICE-SUPPLIES"]) {
      expect(categoriser.decide(raw, "anything")).toMatchObject({ name: "Office Supplies", isNew: false, source: "file" });
    }
  });

  it("matches another name of the same standard category", () => {
    const categoriser = createImportCategoriser({ categories: categories("Electricity and Utilities"), history: [], businessType: null });
    expect(categoriser.decide("Utilities", "x")).toMatchObject({ name: "Electricity and Utilities", isNew: false });
  });

  it("keeps an explicit name the business does not have, and creates it once for every spelling", () => {
    const categoriser = createImportCategoriser({ categories: categories("Office Supplies"), history: [], businessType: null });
    expect(categoriser.decide("Printing", "Ink")).toMatchObject({ name: "Printing", isNew: true, source: "file", confidence: "high" });
    expect(categoriser.decide("printing", "Toner").name).toBe("Printing");
  });

  it("never replaces an explicit category with a suggestion from the description", () => {
    const categoriser = createImportCategoriser({ categories: categories("Marketing"), history: [], businessType: null });
    expect(categoriser.decide("Marketing", "Printer Ink").name).toBe("Marketing");
  });
});
