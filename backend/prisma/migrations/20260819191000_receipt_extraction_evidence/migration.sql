-- Receipt extraction evidence (Workstream B): versioned provenance,
-- per-field evidence, and machine-readable warning codes. All additive JSONB;
-- rows scanned before this simply carry nulls and the clients fall back to
-- today's behaviour.
ALTER TABLE "ReceiptScan"
  ADD COLUMN "ReceiptScan_ExtractorVersions" JSONB,
  ADD COLUMN "ReceiptScan_FieldEvidence" JSONB,
  ADD COLUMN "ReceiptScan_Warnings" JSONB;

ALTER TABLE "ReceiptScanItem"
  ADD COLUMN "ReceiptScanItem_Evidence" JSONB;
