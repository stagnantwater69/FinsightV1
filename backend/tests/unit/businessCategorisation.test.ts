import { describe, expect, it } from "vitest";
import {
  businessContextOf,
  categoriseReceiptLines,
  productClassOf,
  vendorTypeOf,
  type CategorisableLine,
} from "../../src/lib/itemCategoriser";
import {
  EXPENSE_TAXONOMY,
  categoryKind,
  findExistingCategory,
  normaliseCategoryName,
  taxonomyEntry,
  taxonomyKeyForName,
} from "../../src/lib/expenseTaxonomy";
import { GAISANO_ROWS } from "../helpers/longReceiptFixtures";

/**
 * The local, business-first categoriser. Every case here is decided on the
 * server with no provider call — the receipt text never leaves it.
 */

const line = (name: string, quantity: number | null = 1): CategorisableLine => ({ name, quantity });
function filed(lines: CategorisableLine[], businessType: string | null, vendor: string | null = null) {
  return categoriseReceiptLines(lines, { businessType, vendor }).map((decision) =>
    decision ? { category: taxonomyEntry(decision.key).name, kind: decision.kind, confidence: decision.confidence } : null);
}

describe("the category list", () => {
  it("never gives two categories the same name, or one name two meanings", () => {
    const names = EXPENSE_TAXONOMY.map((entry) => normaliseCategoryName(entry.name));
    expect(new Set(names).size).toBe(names.length);
    const owner = new Map<string, string>();
    for (const entry of EXPENSE_TAXONOMY) {
      for (const name of [entry.name, ...entry.aliases]) {
        const key = normaliseCategoryName(name);
        expect(owner.get(key) ?? entry.key, `${name} belongs to ${owner.get(key)} and ${entry.key}`).toBe(entry.key);
        owner.set(key, entry.key);
      }
    }
  });

  it("keeps business and personal categories apart", () => {
    const business = EXPENSE_TAXONOMY.filter((entry) => entry.kind === "business").map((entry) => entry.name);
    const personal = EXPENSE_TAXONOMY.filter((entry) => entry.kind === "personal").map((entry) => entry.name);
    expect(business).toEqual(expect.arrayContaining(["Inventory / Stock", "Office Supplies", "Equipment", "Electricity and Utilities"]));
    expect(personal).toEqual(expect.arrayContaining(["Groceries", "Personal Care", "Healthcare and Medicine"]));
  });
});

describe("matching the owner's existing categories", () => {
  it.each([
    ["Stock", "inventory"],
    ["INVENTORY", "inventory"],
    ["Products for Resale", "inventory"],
    ["Office Materials", "office_supplies"],
    ["office-supplies", "office_supplies"],
    ["Supplies, Office", "office_supplies"],
    ["Ingredients", "raw_materials"],
    ["Utilities", "electricity"],
    ["Repairs & Maintenance", "repairs"],
  ])("files into the owner's %s", (name, key) => {
    expect(taxonomyKeyForName(name)).toBe(key);
  });

  it("keeps Equipment and Office Equipment separate", () => {
    expect(taxonomyKeyForName("Equipment")).toBe("equipment");
    expect(taxonomyKeyForName("Office Equipment")).toBe("office_equipment");
  });

  it("does not stretch an unrelated name to fit", () => {
    expect(taxonomyKeyForName("Snacks")).toBeNull();
    expect(taxonomyKeyForName("Uncategorized")).toBeNull();
    expect(findExistingCategory([{ name: "Snacks" }, { name: "Stock" }], "inventory")).toEqual({ name: "Stock" });
  });
});

describe("business or personal", () => {
  it.each([
    ["Groceries", "personal"],
    ["Personal Care", "personal"],
    ["Personal Snacks", "personal"],
    ["Inventory / Stock", "business"],
    ["Stock", "business"],
    ["Snacks", "business"],
    ["Uncategorized", "business"],
  ])("reads %s as %s", (name, kind) => {
    expect(categoryKind(name)).toBe(kind);
  });
});

describe("what a line is", () => {
  it.each([
    ["CASINO ETHYL ALCO FEMME 5", "personal_care"],
    ["SAFEGUARD BAR A/FRSH175/1", "personal_care"],
    ["FEMME BT300 2PLY 128+CTTN", "household"],
    ["SMART D/WSHNG PASTE LMN 2", "cleaning"],
    ["EFFICASCENT OIL ES 25ML", "medicine"],
    ["UFC BANANA CATSUP S/POUCH", "staple_food"],
    ["KOPIKO BRWN COFFEE27.5/20", "staple_food"],
    ["SUPER BAWANG 50G/10S", "snack_drink"],
    ["JBC HAPPY NUTS GARLIC 56X", "snack_drink"],
    ["CHAM SUPER TATTOO BG 200S", "snack_drink"],
    ["CHAMPION DETERGENT BAR", "cleaning"],
    ["ECOPRO SPOON BIG WHITEX12", "packaging"],
    ["STRAWBERRY JAM", null],
    ["BOND PAPER A4 SUB20", "office_supply"],
    ["EPSON L3210 PRINTER", "office_equipment"],
    ["IMARFLEX RICE COOKER 1.8L", "appliance"],
    ["UNLEADED 91", "fuel"],
    ["MERALCO BILL SEPT", "electricity"],
    ["PLDT FIBR 1299", "telecom"],
    ["UREA FERTILIZER 50KG", "agri_input"],
    ["RUBBER SANDALS", "clothing"],
    ["ZX-9 GIZMO KIT", null],
  ])("reads %s as %s", (name, cls) => {
    expect(productClassOf(name)).toBe(cls);
  });

  it("recognises every line of a real Gaisano restocking receipt", () => {
    expect(GAISANO_ROWS.filter((row) => productClassOf(row[4]) === null).map((row) => row[4])).toEqual([]);
  });
});

describe("the business and the shop", () => {
  it.each([
    ["Sari-sari store", "reseller"],
    ["Retail store", "reseller"],
    ["Online selling", "reseller"],
    ["Food business", "food"],
    ["Bakery", "food"],
    ["Agriculture", "agriculture"],
    ["Services", "services"],
    ["", "unknown"],
  ])("reads the business type %s as %s", (type, context) => {
    expect(businessContextOf(type)).toBe(context);
  });

  it.each([
    ["GAISANO GRAND", "supermarket"],
    ["PETRON STATION MANDAUE", "fuel_station"],
    ["MERCURY DRUG", "pharmacy"],
    ["ACE HARDWARE", "hardware"],
    ["JOLLIBEE BANILAD", "restaurant"],
    ["NATIONAL BOOK STORE", "bookstore"],
    ["MERALCO", "electric_utility"],
    ["ABC TRADING", null],
  ])("reads the shop %s as %s", (vendor, type) => {
    expect(vendorTypeOf(vendor)).toBe(type);
  });
});

describe("business first, from the receipt's own context", () => {
  it("files a sari-sari store's restocking run as stock", () => {
    const decisions = filed(GAISANO_ROWS.map((row) => line(row[4], row[1])), "Sari-sari store", "GAISANO GRAND");
    expect(decisions.every((decision) => decision?.category === "Inventory / Stock" && decision.confidence === "medium")).toBe(true);
  });

  it("files office supplies and equipment as business costs", () => {
    expect(filed([line("BOND PAPER A4", 2), line("BALLPEN BLACK", 12), line("FOLDER LONG", 20), line("EPSON L3210 PRINTER")], "Services")).toEqual([
      { category: "Office Supplies", kind: "business", confidence: "medium" },
      { category: "Office Supplies", kind: "business", confidence: "medium" },
      { category: "Office Supplies", kind: "business", confidence: "medium" },
      { category: "Office Equipment", kind: "business", confidence: "medium" },
    ]);
  });

  it("files utilities and operating costs under their operating categories", () => {
    expect(filed([line("MERALCO BILL SEPT"), line("PLDT FIBR 1299"), line("UNLEADED 91"), line("BUSINESS PERMIT RENEWAL")], "Sari-sari store")
      .map((decision) => decision?.category)).toEqual([
      "Electricity and Utilities", "Internet and Telecommunications", "Fuel", "Licenses and Permits",
    ]);
  });

  it("separates business and personal lines on one receipt, and flags the personal ones", () => {
    expect(filed([line("HP INK CARTRIDGE 680"), line("BOND PAPER A4"), line("SUNSILK SHAMPOO 180ML"), line("GARDENIA BREAD LOAF")], "Services")).toEqual([
      { category: "Printing Supplies", kind: "business", confidence: "medium" },
      { category: "Office Supplies", kind: "business", confidence: "medium" },
      { category: "Personal Care", kind: "personal", confidence: "low" },
      { category: "Groceries", kind: "personal", confidence: "low" },
    ]);
  });

  it("treats a household shop as personal when nothing says it is for the business", () => {
    const decisions = filed([line("GARDENIA BREAD"), line("COLGATE TOOTHPASTE"), line("DOVE SOAP")], "", "SAVEMORE MARKET");
    expect(decisions.map((decision) => decision?.category)).toEqual(["Groceries", "Personal Care", "Personal Care"]);
    expect(decisions.every((decision) => decision?.kind === "personal" && decision.confidence === "low")).toBe(true);
  });

  it("files one bottle of shampoo as stock for a store, but asks", () => {
    const [decision] = categoriseReceiptLines([line("SUNSILK SHAMPOO 180ML")], { businessType: "Sari-sari store", vendor: "SAVEMORE" });
    expect(decision).toMatchObject({ key: "inventory", confidence: "low" });
    expect(decision!.reason).toMatch(/personal use/);
  });

  it("files a food business's ingredients, drinks for resale, packaging and cleaning apart", () => {
    expect(filed([line("RICE 25KG"), line("COKE 1.5L", 6), line("FOOD PACK 100S"), line("ZONROX BLEACH 1L"), line("CASINO ALCOHOL 500ML")], "Food business")
      .map((decision) => decision?.category)).toEqual([
      "Raw Materials", "Inventory / Stock", "Packaging Materials", "Cleaning Supplies", "Cleaning Supplies",
    ]);
  });

  it("reads food at a restaurant as a meal, and flags it", () => {
    expect(filed([line("1PC CHICKENJOY W RICE"), line("SPAGHETTI SOLO")], "Services", "JOLLIBEE BANILAD")).toEqual([
      { category: "Business Meals", kind: "business", confidence: "low" },
      { category: "Business Meals", kind: "business", confidence: "low" },
    ]);
  });

  it("files load bought by a sari-sari store as stock", () => {
    expect(filed([line("SMART REGULAR LOAD 500")], "Sari-sari store")[0]?.category).toBe("Inventory / Stock");
  });

  it("files a farm's inputs as raw materials", () => {
    expect(filed([line("UREA FERTILIZER 50KG", 4)], "Agriculture")[0]).toEqual({ category: "Raw Materials", kind: "business", confidence: "medium" });
  });

  it("files a line only its shop explains, and says so", () => {
    const [decision] = categoriseReceiptLines([line("PREM 95")], { businessType: "Services", vendor: "PETRON STATION" });
    expect(decision).toMatchObject({ key: "fuel", source: "shop", confidence: "low" });
  });

  it("leaves a line nothing explains uncategorised rather than guess", () => {
    expect(filed([line("ZX-9 GIZMO KIT")], "Services", "ABC TRADING")).toEqual([null]);
  });
});

describe("two of the owner's categories answering to one standard category", () => {
  it("prefers the one under the standard name, then the first listed", () => {
    expect(findExistingCategory([{ name: "Stock" }, { name: "Inventory / Stock" }], "inventory")).toEqual({ name: "Inventory / Stock" });
    expect(findExistingCategory([{ name: "Stock" }, { name: "Inventory" }], "inventory")).toEqual({ name: "Stock" });
  });
});
