import type { Prisma } from "@prisma/client";
import { prisma } from "../../config/prisma";

export type AnalysisWriteClient = Prisma.TransactionClient;
export type AnalysisMutationGuard = <T>(mutation: (db: AnalysisWriteClient) => Promise<T>) => Promise<T>;

export const runAnalysisMutation: AnalysisMutationGuard = async (mutation) => {
  if (typeof prisma.$transaction !== "function") {
    return mutation(prisma as unknown as AnalysisWriteClient);
  }
  return prisma.$transaction((db) => mutation(db));
};
