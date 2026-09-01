-- Recovery Target plan §7.1 — IANA timezone identifier on BusinessProfile.
-- Purely additive: the NOT NULL DEFAULT clause backfills every existing row
-- to 'Asia/Manila' as part of this single ALTER TABLE (Postgres rewrites the
-- column for all existing rows when a DEFAULT is combined with NOT NULL on
-- ADD COLUMN), not just future inserts. IANA-format validation happens at
-- the application layer (Node's Intl.supportedValuesOf("timeZone")); this
-- column only enforces a length bound.
--
-- Note: `prisma migrate diff` against the current CLI also emitted 9
-- unrelated `RenameIndex` statements (Postgres 63-byte identifier-truncation
-- differences on index names for AnomalyFinding/CategoryStatistics/
-- ExpenseRecord/ReceiptScan/RecurringPattern, unrelated to BusinessProfile).
-- This is pre-existing drift documented in
-- docs/P1B-MIGRATION-HISTORY-INVESTIGATION.md (finding #4) from a Prisma CLI
-- version difference versus whatever authored those five migrations
-- originally. It is deliberately excluded from this migration to keep this
-- change purely additive and in scope; it would need its own ticket.

-- AlterTable
ALTER TABLE "BusinessProfile" ADD COLUMN     "BusinessProfile_Timezone" VARCHAR(64) NOT NULL DEFAULT 'Asia/Manila';

