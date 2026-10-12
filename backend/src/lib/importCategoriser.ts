import { categoryFromHistory, type ConfirmedCategoryChoice } from "./categoryHistory";
import {
  findExistingCategory,
  normaliseCategoryName,
  taxonomyEntry,
  taxonomyKeyForName,
  type TaxonomyKey,
} from "./expenseTaxonomy";
import { categoriseReceiptLines, productClassOf, type CategoryConfidence } from "./itemCategoriser";
import { DEFAULT_IMPORT_CATEGORY } from "./recordTypeDetection";

/**
 * Categories for imported expense rows, decided locally.
 *
 * D0-03 (docs/phase-0/README.md) governs CSV imports the same way it governs
 * receipts: the free deterministic path, in this order, and nothing leaves the
 * server to decide it.
 *
 *   1. What the file (or the owner, in review) says. Matched to the owner's
 *      existing category under any of its names, so "office supply" lands in
 *      their "Office Supplies" instead of beside it.
 *   2. The owner's own earlier choice for this exact description and vendor.
 *   3. The business-first item categoriser that receipts use
 *      (lib/itemCategoriser), read against the business type.
 *   4. Ledger words that spreadsheets use and receipts never print
 *      ("Store Inventory", "Accountant fee"), matched to the standard list.
 *
 * Each answer lands in the owner's existing category when they have one for
 * it, or a broader one they already use; only when nothing fits is a standard
 * category proposed as NEW. It is created when the owner confirms the import
 * that listed it, which is the owner approval D0-03 requires. A row nothing
 * explains is filed under Uncategorised and counted, never guessed at.
 */

export type ImportCategorySource = "file" | "history" | "suggested" | "none";

export interface ImportCategoryDecision {
  /** The category the row will be saved under. */
  name: string;
  source: ImportCategorySource;
  /** Not one of the business's categories yet: confirming the import creates it. */
  isNew: boolean;
  /** "high" only when the file or the owner named it, per D0-03. */
  confidence: "high" | CategoryConfidence;
}

export interface ImportCategoriserInput {
  /** The business's categories, oldest first. */
  categories: { id: number; name: string }[];
  history: ConfirmedCategoryChoice[];
  businessType: string | null;
}

const UNCATEGORISED_PATTERN = /^uncategori[sz]ed$/i;

/**
 * A narrower standard category the owner does not have, filed under a broader
 * one they do. Ink goes in their "Office Supplies" before FinSight proposes a
 * separate "Printing Supplies" beside it.
 */
const BROADER: Partial<Record<TaxonomyKey, TaxonomyKey[]>> = {
  printing_supplies: ["office_supplies"],
  office_equipment: ["equipment"],
  electronics: ["office_equipment", "equipment"],
  furniture: ["equipment"],
  tools: ["equipment"],
  water: ["electricity"],
  cleaning_supplies: ["store_supplies"],
  fuel: ["transport"],
  employee_benefits: ["salaries"],
  interest: ["other_financial", "bank_fees"],
  other_financial: ["bank_fees"],
};

/**
 * Bookkeeping words a spreadsheet uses for a line and a receipt does not.
 * Checked after the item categoriser, so a line that names a product is still
 * read as the product.
 */
const LEDGER_WORDS: { pattern: RegExp; key: TaxonomyKey; confidence: CategoryConfidence }[] = [
  { pattern: /\b(inventory|stocks?|restock(ing)?|paninda|merchandise|resale)\b/, key: "inventory", confidence: "medium" },
  { pattern: /\b(ingredients?|raw materials?)\b/, key: "raw_materials", confidence: "medium" },
  { pattern: /\b(accountant|bookkeep(er|ing)|lawyer|attorney|notary|notarial|consultan(t|cy)|audit fee)\b/, key: "professional_services", confidence: "medium" },
  { pattern: /\b(sss|philhealth|pag ?ibig|hdmf|13th month)\b/, key: "employee_benefits", confidence: "medium" },
  { pattern: /\b(bir|vat|percentage tax|withholding tax|income tax|real property tax|amilyar)\b/, key: "business_taxes", confidence: "medium" },
  { pattern: /\b(loan interest|interest)\b/, key: "interest", confidence: "low" },
  { pattern: /\b(repairs?|maintenance)\b/, key: "repairs", confidence: "medium" },
  { pattern: /\butilit(y|ies)\b/, key: "electricity", confidence: "medium" },
  { pattern: /\b(lunch|dinner|breakfast|meals?|merienda|snacks for (staff|meeting))\b/, key: "business_meals", confidence: "low" },
  { pattern: /\b(groceries|grocery)\b/, key: "groceries", confidence: "low" },
  { pattern: /\b(misc|miscellaneous|sundry)\b/, key: "other_operating", confidence: "low" },
];

/** Description text as the ledger words expect it. */
function ledgerText(text: string): string {
  return text.toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * A standard category named inside the description itself: "Monthly Rent",
 * "Utilities - Sept". Tries every run of one to three words against the
 * standard names and their aliases.
 */
function aliasInDescription(description: string): TaxonomyKey | null {
  const words = ledgerText(description).split(" ").filter(Boolean);
  for (let size = 3; size >= 1; size -= 1) {
    for (let at = 0; at + size <= words.length; at += 1) {
      const key = taxonomyKeyForName(words.slice(at, at + size).join(" "));
      if (key) return key;
    }
  }
  return null;
}

function tidy(name: string): string {
  return name.trim().replace(/\s+/g, " ");
}

export function createImportCategoriser(input: ImportCategoriserInput) {
  const uncategorisedExisting = input.categories.find((category) => UNCATEGORISED_PATTERN.test(category.name.trim()));
  const uncategorisedName = uncategorisedExisting?.name ?? DEFAULT_IMPORT_CATEGORY;
  const assignable = input.categories.filter((category) => !UNCATEGORISED_PATTERN.test(category.name.trim()));
  const assignableIds = new Set(assignable.map((category) => category.id));

  const existingByNorm = new Map<string, string>();
  for (const category of assignable) {
    const key = normaliseCategoryName(category.name);
    if (!existingByNorm.has(key)) existingByNorm.set(key, category.name);
  }
  /** New names this import has already proposed, so two spellings make one category. */
  const proposedByNorm = new Map<string, string>();
  const memo = new Map<string, ImportCategoryDecision>();

  const uncategorised: ImportCategoryDecision = {
    name: uncategorisedName,
    source: "none",
    isNew: !uncategorisedExisting,
    confidence: "low",
  };

  function existingFor(key: TaxonomyKey): string | null {
    const direct = findExistingCategory(assignable, key);
    if (direct) return direct.name;
    for (const broader of BROADER[key] ?? []) {
      const match = findExistingCategory(assignable, broader);
      if (match) return match.name;
    }
    return null;
  }

  function propose(name: string): string {
    const norm = normaliseCategoryName(name);
    const already = proposedByNorm.get(norm);
    if (already) return already;
    proposedByNorm.set(norm, name);
    return name;
  }

  function fromTaxonomy(key: TaxonomyKey, confidence: CategoryConfidence): ImportCategoryDecision {
    const existing = existingFor(key);
    if (existing) return { name: existing, source: "suggested", isNew: false, confidence };
    return { name: propose(taxonomyEntry(key).name), source: "suggested", isNew: true, confidence };
  }

  /** What the file or the owner wrote, matched to what the business already has. */
  function fromNamed(raw: string): ImportCategoryDecision {
    const name = tidy(raw);
    if (UNCATEGORISED_PATTERN.test(name)) return { ...uncategorised, source: "file", confidence: "high" };
    const existing = existingByNorm.get(normaliseCategoryName(name));
    if (existing) return { name: existing, source: "file", isNew: false, confidence: "high" };
    // The same standard category under another of its names ("Utilities"
    // for the owner's "Electricity and Utilities"). Not a broader one: an
    // explicit name is kept unless it is the same category.
    const key = taxonomyKeyForName(name);
    const sameCategory = key ? findExistingCategory(assignable, key) : null;
    if (sameCategory) return { name: sameCategory.name, source: "file", isNew: false, confidence: "high" };
    return { name: propose(name), source: "file", isNew: true, confidence: "high" };
  }

  function fromDescription(description: string, vendor: string | undefined): ImportCategoryDecision {
    const history = categoryFromHistory(input.history, description, vendor);
    if (history && assignableIds.has(history.categoryId)) {
      return { name: history.categoryName, source: "history", isNew: false, confidence: "medium" };
    }

    const itemNamed = productClassOf(description) !== null;
    const decision = categoriseReceiptLines(
      [{ name: description, quantity: null }],
      { businessType: input.businessType, vendor: vendor ?? null },
    )[0];
    if (decision && itemNamed) return fromTaxonomy(decision.key, decision.confidence);

    const text = ledgerText(description);
    const ledger = LEDGER_WORDS.find((entry) => entry.pattern.test(text));
    if (ledger) return fromTaxonomy(ledger.key, ledger.confidence);
    const alias = aliasInDescription(description);
    if (alias) return fromTaxonomy(alias, "medium");

    // Nothing in the words; the kind of shop is the last, weakest clue.
    if (decision) return fromTaxonomy(decision.key, "low");
    return uncategorised;
  }

  return {
    /**
     * The category for one expense row. `raw` is the category cell (or the
     * owner's correction); an empty one asks FinSight to suggest.
     */
    decide(raw: string | undefined | null, description: string, vendor?: string | null): ImportCategoryDecision {
      const named = raw?.trim();
      const memoKey = named ? `n\u0000${named.toLowerCase()}` : `d\u0000${description.trim().toLowerCase()}\u0000${(vendor ?? "").trim().toLowerCase()}`;
      const cached = memo.get(memoKey);
      if (cached) return cached;
      const decided = named ? fromNamed(named) : fromDescription(description, vendor?.trim() || undefined);
      memo.set(memoKey, decided);
      return decided;
    },
    uncategorisedName,
  };
}

export type ImportCategoriser = ReturnType<typeof createImportCategoriser>;
