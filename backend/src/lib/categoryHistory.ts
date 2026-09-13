import { prisma } from "../config/prisma";

export interface ConfirmedCategoryChoice {
  description: string;
  vendor: string | null;
  categoryId: number;
  categoryName: string;
}

const normalise = (value: string) => value.trim().toLowerCase().replace(/\s+/g, " ");
const isUncategorised = (name: string) => /^uncategori[sz]ed$/i.test(name.trim());

/** Call only after authenticating ownership of the active business profile. */
export async function loadConfirmedCategoryHistory(businessProfileId: number): Promise<ConfirmedCategoryChoice[]> {
  const records = await prisma.expenseRecord.findMany({
    where: {
      businessProfileId,
      category: { businessProfileId },
      OR: [{ receiptScanId: null }, { receiptScan: { confirmationStatus: "Confirmed" } }],
    },
    select: { description: true, vendor: true, categoryId: true, category: { select: { name: true } } },
    orderBy: { id: "desc" },
    take: 200,
  });
  return records.filter((record) => !isUncategorised(record.category.name)).map((record) => ({
    description: record.description,
    vendor: record.vendor,
    categoryId: record.categoryId,
    categoryName: record.category.name,
  }));
}

/** Exact wording, preserving quantities and product digits; no fuzzy guesses. */
export function categoryFromHistory(history: ConfirmedCategoryChoice[], description: string, vendor?: string | null) {
  const descriptionKey = normalise(description);
  if (!descriptionKey) return null;
  const matches = history.filter((choice) => normalise(choice.description) === descriptionKey);
  const vendorKey = vendor ? normalise(vendor) : null;
  const match = (vendorKey ? matches.find((choice) => choice.vendor && normalise(choice.vendor) === vendorKey) : null)
    ?? matches[0];
  return match ? { categoryId: match.categoryId, categoryName: match.categoryName, source: "history" as const } : null;
}
