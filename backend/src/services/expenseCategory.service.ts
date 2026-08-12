import { prisma } from "../config/prisma";
import { requireOwnedBusinessProfile } from "../lib/ownership";
import type { ExpenseCategory } from "@prisma/client";

interface CreateInput {
  businessProfileId: number;
  name: string;
  description?: string;
}

function toDTO(category: ExpenseCategory) {
  return {
    id: category.id,
    businessProfileId: category.businessProfileId,
    name: category.name,
    description: category.description,
    createdAt: category.createdAt,
  };
}

export async function createCategory(userId: number, input: CreateInput) {
  await requireOwnedBusinessProfile(userId, input.businessProfileId);
  const category = await prisma.expenseCategory.create({
    data: {
      businessProfileId: input.businessProfileId,
      name: input.name,
      description: input.description,
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
