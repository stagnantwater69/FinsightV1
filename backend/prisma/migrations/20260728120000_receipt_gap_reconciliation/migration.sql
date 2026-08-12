-- Receipt gap reconciliation.
--
-- Both columns are additive and nullable/defaulted, so this is safe to apply
-- to a database with existing rows: nothing is rewritten and no existing
-- query changes meaning.

-- The share of receipt-level tax / service charge / discount folded into this
-- record's amount. Signed: negative for a discount. NULL on records created
-- before this column existed and on receipts that reconciled exactly.
ALTER TABLE "ExpenseRecord" ADD COLUMN "ExpenseRecord_AllocatedCharges" DECIMAL(12,2);

-- False for a line OCR read off the image, true for one the owner typed in on
-- the confirm screen. Existing rows were all machine-extracted, so the FALSE
-- default backfills them correctly.
ALTER TABLE "ReceiptScanItem" ADD COLUMN "ReceiptScanItem_AddedByOwner" BOOLEAN NOT NULL DEFAULT false;
