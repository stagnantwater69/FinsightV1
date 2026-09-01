-- Expense Reduction Opportunities plan §5.2 — owner-controlled cost-behavior
-- classification. Additive only: every existing ExpenseCategory row gets the
-- new column at its default (UNCLASSIFIED). No data is altered beyond that;
-- there is deliberately no name-based backfill heuristic (the plan forbids
-- inferring FIXED/VARIABLE/MIXED from the category name).

-- CreateEnum
CREATE TYPE "ExpenseCostBehavior" AS ENUM ('FIXED', 'VARIABLE', 'MIXED', 'UNCLASSIFIED');

-- AlterTable
ALTER TABLE "ExpenseCategory" ADD COLUMN     "Category_CostBehavior" "ExpenseCostBehavior" NOT NULL DEFAULT 'UNCLASSIFIED';
