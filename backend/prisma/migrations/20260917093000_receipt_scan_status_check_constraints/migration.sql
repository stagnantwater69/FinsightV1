-- Hold ReceiptScan's two status columns to the sets the code actually uses.
--
-- Both were free-text VARCHAR(50). Every query that finds a scan matches on
-- them: the worker's claim (processingStatus = 'Processing'), the sweep
-- (confirmationStatus = 'Pending' AND processingStatus IN ('Complete',
-- 'Failed')), the owner's history filters, the purge path's 'Deletion Pending'
-- gate. One write of anything else -- a typo, a future caller, a hand-run
-- UPDATE -- leaves a row that matches none of them, so it is never processed,
-- never shown and never swept, while it goes on holding the receipt's raw OCR
-- text and the storage paths of the photographs.
--
-- CHECK rather than a Prisma enum: an enum retypes two columns on the busiest
-- table in the receipt path, under an ACCESS EXCLUSIVE lock, and changes the
-- generated client type for columns that services outside this file's
-- ownership read and write as strings.
--
-- Added NOT VALID and validated separately so this cannot abort a deploy on a
-- database that already holds a bad row. VALIDATE runs only when nothing
-- violates the constraint; otherwise it stays NOT VALID, which still binds
-- every future insert and update, and the migration says so.
ALTER TABLE public."ReceiptScan"
  ADD CONSTRAINT "ReceiptScan_confirmation_status_check"
  CHECK ("ReceiptScan_ConfirmationStatus" IN ('Pending', 'Confirmed', 'Deletion Pending'))
  NOT VALID;

ALTER TABLE public."ReceiptScan"
  ADD CONSTRAINT "ReceiptScan_processing_status_check"
  CHECK ("ReceiptScan_ProcessingStatus" IN ('Processing', 'Complete', 'Failed'))
  NOT VALID;

DO $status_checks$
DECLARE
  bad_confirmation BIGINT;
  bad_processing BIGINT;
BEGIN
  SELECT count(*) INTO bad_confirmation
  FROM public."ReceiptScan"
  WHERE "ReceiptScan_ConfirmationStatus" NOT IN ('Pending', 'Confirmed', 'Deletion Pending');

  IF bad_confirmation = 0 THEN
    ALTER TABLE public."ReceiptScan" VALIDATE CONSTRAINT "ReceiptScan_confirmation_status_check";
  ELSE
    RAISE WARNING
      'ReceiptScan_confirmation_status_check left NOT VALID: % existing row(s) hold a confirmation status outside the supported set. New writes are already constrained; the existing rows need an owner decision before VALIDATE CONSTRAINT can run.',
      bad_confirmation;
  END IF;

  SELECT count(*) INTO bad_processing
  FROM public."ReceiptScan"
  WHERE "ReceiptScan_ProcessingStatus" NOT IN ('Processing', 'Complete', 'Failed');

  IF bad_processing = 0 THEN
    ALTER TABLE public."ReceiptScan" VALIDATE CONSTRAINT "ReceiptScan_processing_status_check";
  ELSE
    RAISE WARNING
      'ReceiptScan_processing_status_check left NOT VALID: % existing row(s) hold a processing status outside the supported set. New writes are already constrained; the existing rows need an owner decision before VALIDATE CONSTRAINT can run.',
      bad_processing;
  END IF;
END
$status_checks$;
