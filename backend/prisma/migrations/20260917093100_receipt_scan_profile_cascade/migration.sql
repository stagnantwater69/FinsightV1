-- Deleting a business profile now deletes its receipt scans instead of
-- orphaning them.
--
-- ReceiptScan -> BusinessProfile was ON DELETE SET NULL. Account deletion
-- deletes the user's scans and then the user, but those are separate steps
-- over separate rows: a scan committed between them was merely detached, and
-- nothing then removed it, because accountDeletion.service.ts deliberately
-- refuses to sweep scans with a null profile -- an unattributable row cannot
-- be deleted on one account's behalf without risking another's. What was left
-- was a row no owner could see and no sweep would collect, still holding
-- rawText, the extracted vendor, date and amount, and the storage paths of the
-- photographs.
--
-- CASCADE removes the window rather than narrowing it. The scan's children
-- (pages, items, field corrections) already cascade from the scan; the audit
-- rows that must outlive a scan (ExternalProviderDispatch, ReceiptPurgeJob,
-- ExpenseRecord) reference it ON DELETE SET NULL and are unaffected.
--
-- Scans orphaned before today are NOT removed here. They still carry the
-- storage paths of objects that also still exist, and dropping the rows would
-- destroy the only record of which objects to delete. They need a one-off
-- sweep that purges storage and rows together.
ALTER TABLE public."ReceiptScan"
  DROP CONSTRAINT "ReceiptScan_BusinessProfile_ID_fkey";

ALTER TABLE public."ReceiptScan"
  ADD CONSTRAINT "ReceiptScan_BusinessProfile_ID_fkey"
  FOREIGN KEY ("BusinessProfile_ID")
  REFERENCES public."BusinessProfile"("BusinessProfile_ID")
  ON DELETE CASCADE ON UPDATE CASCADE;
