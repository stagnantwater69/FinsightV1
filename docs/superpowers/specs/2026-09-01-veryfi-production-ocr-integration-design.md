# Veryfi as a production OCR rescue provider

Date: 2026-09-01
Status: approved, ready for implementation
Scope: `backend/` only (`receiptScan/extraction.ts`, `receiptScan/worker.ts`, `config/env.ts`, `prisma/schema.prisma` + migration). No web, mobile, or ML Kit/capture changes.

## Problem

`tests/ocr-accuracy/veryfi-spike.ts` (a separate one-off benchmarking script) already established that Veryfi's receipt-OCR API reads hard, real-world receipts — heavy paper-grain texture, thermal print degradation — dramatically better than FinSight's own deterministic Tesseract pipeline. This was directly confirmed on a real customer receipt during this session: Tesseract read it as unrecoverable noise (confidence 22-25, every image-preprocessing variant tried — denoise, threshold, alternate page-segmentation modes — still failed) while Veryfi's own demo app extracted every field correctly.

The owner wants Veryfi to actually help real scans, not just the benchmarking corpus — as a first-choice rescue when Tesseract struggles, falling back to the existing Gemini vision-rescue once a monthly quota is used up, with Veryfi's real-scan output recorded for later comparison against Tesseract's.

This is a materially different thing from the benchmarking script: it means sending real customer receipt images (names, purchases, sometimes partial card info) to a third-party paid API in production, for the first time. `veryfi-spike.ts`'s own header ("MEASUREMENT ONLY — this is not wired into the app and nothing here runs in production") stops being true for this path once this ships; that script and its corpus-only usage are otherwise unaffected.

## Decisions taken before design

1. **Veryfi is a rescue, not a first-pass replacement for Tesseract.** It's only called when Tesseract already shows one of the existing struggle signals (`extraction.ts:188-197`: no items, no total, doesn't add up, or confidence below `LOW_CONFIDENCE`) — the same conditions that already trigger the Gemini vision-rescue today. Calling Veryfi on every scan, including ones Tesseract already reads perfectly, would burn a small trial quota on receipts that never needed help.
2. **Veryfi tries first among rescues; Gemini vision-rescue is the fallback**, not something replaced. If Veryfi is disabled, this month's quota is exhausted, or the call errors, the pipeline falls through to exactly the `rescueWithVision` (Gemini) path that exists today — today's behavior is unchanged in that case.
3. **A new monthly request counter**, since no usage-quota tracking exists anywhere in this backend today. A configurable limit, checked before each call; once hit, Veryfi is skipped for the rest of the calendar month without a restart.
4. **Off by default.** `VERYFI_ENABLED` follows the exact shape of the existing `ANOMALY_*_ENABLED` flags in `env.ts:50-54` (boolean, read once at process start, requires a restart to flip) — this ships dark and is turned on deliberately.
5. **Real-scan comparison is passive, recorded data only.** Whenever Veryfi is actually called, its raw fields are stored alongside Tesseract's for later manual review — no automatic parser changes, no scoring job. Same spirit as the existing corpus benchmarking, just against real scans.

## Design

### Trigger and fallback order

`extraction.ts`'s existing trigger check (`no-items` / `no-total` / `does-not-add-up` / `low-confidence`, `extraction.ts:188-197`) is unchanged. Where `rescueWithVision` is currently called unconditionally once triggered, it becomes:

```
if (trigger) {
  if (VERYFI_ENABLED && quotaAvailable()) {
    const veryfiResult = await rescueWithVeryfi(...)   // never throws, same contract as rescueWithVision
    if (veryfiResult.succeeded) return veryfiResult    // Veryfi wins
    // falls through on failure/rejection — Gemini still gets a chance
  }
  return rescueWithVision(...)   // existing Gemini path, unchanged
}
```

`rescueWithVeryfi` (new function, `extraction.ts` or a sibling file next to it) mirrors `rescueWithVision`'s existing contract exactly: same `RescuedFields`-shaped return, never throws, records its own audit fields the same way `visionProvider`/`visionRejectReason` already do for Gemini. It calls Veryfi's document endpoint the same way `tests/ocr-accuracy/veryfi-spike.ts` already does (`Client-Id` + `Authorization: apikey {username}:{key}` headers), reusing the same four `VERYFI_*` env vars added earlier this session — this is the one piece of code that turns those from "spike-only" credentials into a real production dependency.

### Quota

New table `VeryfiUsage` (`month: string` — `"2026-09"` — primary key, `count: int`). Before calling Veryfi: read (or create) the current month's row, compare `count` against `VERYFI_MONTHLY_LIMIT` (new optional env var, `env.ts`, same `z.string().optional()`-adjacent numeric pattern as `TRUST_PROXY_HOPS`). At/over the limit, skip straight to the Gemini fallback — same as `VERYFI_ENABLED=false`. Increment happens only on an actual call attempt (a skipped call never increments).

### Recording for comparison

New columns on `ReceiptScanPage` (additive migration, alongside the existing uncommitted `ocrSource`/`originalOcrConfidence` migration — this is a separate migration, not a modification of that one): `veryfiAttempted: boolean default false`, `veryfiVendor`, `veryfiDate`, `veryfiAmount` (all nullable), `veryfiRejectReason: string?`. A `rescueProvider: "veryfi" | "gemini" | null` column records which rescue actually won for a given page, so a later query can directly compare "what Veryfi read" vs. "what Tesseract read" vs. "what actually got used" across real scans — same audit trail shape the existing `visionProvider` column already establishes, extended to cover the new provider.

### Rollout

`VERYFI_ENABLED=false` by default in both `.env.example` and any deployed environment. Turning it on is a deliberate, separate action from this implementation — this spec does not turn it on anywhere.

## Out of scope

- Automatic parser/heuristic changes driven by Veryfi's output — recording only.
- Any change to when a rescue is triggered in the first place (the four existing conditions are untouched).
- Any change to `veryfi-spike.ts` or the benchmarking corpus workflow.
- User-facing disclosure/consent copy about third-party OCR processing — a product/legal question outside this technical spec's scope, worth raising separately before `VERYFI_ENABLED` is actually flipped on in production.
- Mobile or web changes of any kind.

## Testing

- Unit coverage for `rescueWithVeryfi`'s contract (never throws, correct field mapping from Veryfi's response shape, matching how `visionOcr.service.ts`/`rescueWithVision` are presumably already tested) and for the quota check (`quotaAvailable()` at/under/over the limit, month-rollover behavior).
- Integration test for the fallback chain: Veryfi disabled → Gemini path unchanged (regression-proof against today's behavior); Veryfi enabled + quota available + Veryfi succeeds → Veryfi's fields win; Veryfi enabled but quota exhausted → falls to Gemini without attempting Veryfi.
- `npx prisma validate` and a real migration run against the throwaway test DB, per this repo's standing backend verification gate.
- No live call to the real Veryfi API in automated tests — mock the HTTP layer, the same way `visionOcr.service.ts`'s existing tests presumably mock Gemini.
