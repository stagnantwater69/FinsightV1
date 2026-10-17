---
name: finsight-receipt-pipeline
description: Use before changing anything in the receipt scan/extraction path — upload, queue, worker, OCR, provider dispatch, merge, evidence, warnings, or the review screens. Maps the stages and states the invariants that are easy to break without a test noticing.
---

# FinSight receipt pipeline

## Overview

Reading a receipt spans three services, a worker, an external provider and two
clients. Most of the logic is deliberate and documented in long comments at
the call sites: read those before changing behaviour. This skill is the map
plus the invariants that a passing test suite will not always protect.

The whole pipeline exists to serve one rule: **a number the owner did not
approve never lands in their books.** Every guard below is downstream of it.

## Stages, and the file that owns each

| Stage | File |
|---|---|
| Upload, dedupe, scan + page rows | `backend/src/services/receiptScan/queue.ts` |
| Claim a scan under a lease, run the pass | `backend/src/services/receiptScan/worker.ts` |
| Local OCR + preprocessing, warm worker pool | `backend/src/services/ocr.service.ts` |
| Pick original vs processed read | `backend/src/services/receiptScan/ocrCandidateSelection.ts` |
| Parse fields, items, reconcile to the total | `backend/src/services/ocr.service.ts`, `backend/src/lib/receiptTextSignals.ts` |
| Items across photographs, overlap at the seams | `backend/src/services/receiptScan/localItems.ts`, `backend/src/lib/receiptOverlapItems.ts` |
| Printed details (currency, tax, time) | `backend/src/lib/receiptDetails.ts` |
| Decide whether to call the provider | `backend/src/services/receiptRescueDecision.ts` |
| Consent, budget, dispatch, replay | `backend/src/services/receiptProviderDispatch.service.ts` |
| Provider adapters (Gemini, Veryfi) | `backend/src/services/receiptScan/providerAdapters.ts`, `visionOcr.service.ts`, `veryfiOcr.service.ts` |
| Merge provider answer with the local one | `backend/src/services/receiptProviderContract.ts` |
| Field evidence, scan warnings | `backend/src/services/receiptScan/extraction.ts` |
| Persist under the lease, in one transaction | `worker.ts` → `persistReceiptProcessingOutput` |
| Review UI | `web/src/pages/ScanReceipt.tsx`, `mobile/src/screens/records/ScanReceiptScreen.tsx` |

The worker process loop (poll interval, graceful shutdown, `shutdownOcr()`)
lives in `backend/src/worker.ts`. **Nothing scans unless that process is
running** — check it before diagnosing a "slow" or "stuck" scan.

## Invariants

### 1. Which reading wins depends on why the provider was called

`mergeReceiptProviderOutcome` has two modes and they are not interchangeable:

- **rescue** (default): the provider was called because the local read failed.
  Only a *stronger validated* provider field replaces a local one.
- **always** (`RECEIPT_PROVIDER_ROUTING=always`): the provider is the primary
  reader. Its validated answer wins wherever it answered; the local read is
  the fallback for what it left null.

Items are stricter in both modes: a provider list that does not add up to the
total never displaces a local list that does. It is prefilled for owner review
instead, marked `UNVALIDATED` / `OWNER_REVIEW_REQUIRED`.

### 2. Evidence must describe what the receipt corroborated, not who produced it

`localNormalizedExtraction` in `worker.ts` decides what the local read may
claim. Marking a field `VALIDATED` puts it beyond the provider's reach in
rescue mode, so it must mean something checked it:

- vendor: never validated (it is the parser's guess at a header line)
- date: validated only when not locale-ambiguous
- total: validated only when the line items reconcile to it

A field claimed as validated without corroboration is the exact shape of bug
that let a garbage OCR vendor outrank a correct provider reading.

### 3. The ambiguous-date exception is measured, not preferred

If the local date is locale-ambiguous (`03/09/2026`, both parts ≤ 12) and the
provider returns the same digits day/month swapped, the parser's DD/MM reading
stands and stays flagged. Models answer that case inconsistently across runs;
the parser applies the Philippine convention every time. A provider date that
is *not* the swap is a different reading of the paper and wins normally.

### 4. Every write is guarded by the lease

Each attempt owns `(processingWorkerId, processingAttemptCount)`. Every update
re-checks both and throws `ReceiptLeaseLostError` if a newer worker has taken
over. A stale worker must never write a result — success or failure. Heartbeat
during long reads; do not widen a write to skip the guard.

### 5. Provider dispatch is billed and must stay idempotent

`reservationKeyHash` covers profile, scan, provider, versions, rescue reasons
and the input bytes hash. Same bytes and same shape replay the stored outcome
with **no second provider call and no second charge**. Bytes handed to the
provider are re-hashed against `inputSha256` before use. Consent and budget
are checked inside the transaction that marks the dispatch `SUBMITTED`.

### 6. rawText keeps every line, always

`combinedText` — the full, unedited page concatenation — is what gets stored,
even when de-overlapping chose to count fewer lines. The audit trail never
loses text the pipeline chose not to count.

### 7. Currency is read, never converted

A symbol counts only when attached to a printed amount; stray OCR noise must
not reclassify a peso receipt. Tesseract makes "¥" of a pen stroke and "£" of
an 8, so a bare `$`/`¥`/`£`/`€` mark counts only on the total line, on two or
more lines, or on a receipt that prints no pesos at all. A non-PHP receipt sets
`requiresManualCurrencyConversion` and the owner enters the PHP amount. The
app never converts currency itself.

## Before you change anything here

- Reproduce first. A throwaway copy of a real scan row, run through
  `runReceiptWorkerOnce()`, shows the whole pipeline end to end; delete the row
  and its children afterwards.
- The `receipt provider gate` log line carries `ocrMs`, `providerMs`,
  `persistMs`, `totalMs`, the gate code and applied fields, once per scan. Read
  it before theorising about where time goes.
- Latency is usually not the code: the provider call is seconds, and each DB
  round trip costs the network distance to Supabase.
- Ownership isolation is P0. Every query stays scoped to the authenticated
  user's active business profile.
- Never present the mostly-synthetic OCR corpus as real-receipt evidence, and
  never claim camera coverage the mobile app does not have.
