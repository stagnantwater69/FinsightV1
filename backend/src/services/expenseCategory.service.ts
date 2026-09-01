import { prisma } from "../config/prisma";
import { requireOwnedBusinessProfile } from "../lib/ownership";
import { ApiError } from "../middleware/error.middleware";
import type { ExpenseCategory, ExpenseCostBehavior } from "@prisma/client";

interface CreateInput {
  businessProfileId: number;
  name: string;
  description?: string;
  // [ADDED] Owner-controlled cost-behavior classification, per
  // docs/EXPENSE-REDUCTION-OPPORTUNITIES-PLAN.md §5.2/§15 Phase 5. Never
  // guessed from the category name — omitted means the column default
  // (UNCLASSIFIED) applies, exactly as it does for every pre-existing row.
  costBehavior?: ExpenseCostBehavior;
}

interface UpdateInput {
  name?: string;
  description?: string | null;
  costBehavior?: ExpenseCostBehavior;
}

function toDTO(category: ExpenseCategory) {
  return {
    id: category.id,
    businessProfileId: category.businessProfileId,
    name: category.name,
    description: category.description,
    createdAt: category.createdAt,
    costBehavior: category.costBehavior,
  };
}

export async function createCategory(userId: number, input: CreateInput) {
  await requireOwnedBusinessProfile(userId, input.businessProfileId);
  const category = await prisma.expenseCategory.create({
    data: {
      businessProfileId: input.businessProfileId,
      name: input.name,
      description: input.description,
      costBehavior: input.costBehavior,
    },
  });
  return toDTO(category);
}

export async function listCategories(userId: number, businessProfileId: number) {
  await requireOwnedBusinessProfile(userId, businessProfileId);
  const categories = await prisma.expenseCategory.findMany({
    where: { businessProfileId },
    orderBy: { name: "asc" },
  });
  return categories.map(toDTO);
}

export async function updateCategory(userId: number, id: number, input: UpdateInput) {
  const existing = await prisma.expenseCategory.findFirst({
    where: { id, businessProfile: { userId } },
  });
  if (!existing) {
    throw new ApiError(404, "Expense category not found");
  }

  const category = await prisma.expenseCategory.update({
    where: { id },
    data: {
      name: input.name,
      description: input.description,
      costBehavior: input.costBehavior,
    },
  });
  return toDTO(category);
}
