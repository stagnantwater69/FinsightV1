-- Remove three indexes whose only column is already the leading column of a
-- unique index on the same table.
--
-- A btree on (a, b) answers everything a btree on (a) answers, so each of
-- these was a second tree maintained on every insert, update and delete for no
-- read it could serve alone. Two of the three sit on the receipt path, where a
-- multi-page scan writes a page row and a line-item row per page and per line.
--
--   ReceiptScanPage(ReceiptScan_ID)  <- ReceiptScanPage(ReceiptScan_ID, Number)
--   ReceiptScanItem(ReceiptScan_ID)  <- ReceiptScanItem(ReceiptScan_ID, LineNumber)
--   ExpenseCategory(BusinessProfile_ID) <- ExpenseCategory(BusinessProfile_ID, Category_Name)
--
-- The cascades from ReceiptScan and from BusinessProfile use the unique
-- indexes just as well; Postgres does not require a dedicated index for a
-- foreign key, only a usable one.
--
-- Not touched: CSVImportBatch(BusinessProfile_ID), which docs/SECURITY.md
-- lists among the low-priority duplicate-reference indexes. It has no unique
-- starting with that column, so it is not redundant and removing it would cost
-- a real read path.
DROP INDEX IF EXISTS public."ReceiptScanPage_ReceiptScan_ID_idx";
DROP INDEX IF EXISTS public."ReceiptScanItem_ReceiptScan_ID_idx";
DROP INDEX IF EXISTS public."ExpenseCategory_BusinessProfile_ID_idx";
