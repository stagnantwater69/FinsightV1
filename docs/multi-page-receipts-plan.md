# Long receipts — multi-page capture, phased plan

**Status: NOT AUTHORISED TO BUILD.** This plan exists so the work can start the
day it is justified, not so it can start now. The trigger is in §1 and it is a
number from UAT, not a judgement call.

Five phases, each self-contained and executable in a fresh session. Phase 0 is
facts read from source; do not re-derive them from memory.

---

## 1. The trigger — when this gets built

`docs/uat-script.md` Task 4 now records, per participant:

- Did the whole receipt fit in one photo?
- If not, what did they do?
- Did they try to photograph two receipts at once?

**Decision rule, fixed in advance so the result cannot be argued with after the
fact:**

| UAT outcome (of 8 participants) | What to do |
|---|---|
| **0–1 hit it** | Do not build. Ship the two-receipt warning that already exists and leave it. Revisit only if real usage contradicts UAT. |
| **2–3 hit it** | Build Phases 1–3 (storage, capture, review). Skip Phase 4 until asked for. |
| **4+ hit it** | Build all five phases; this is a core flow, not an edge case. |
| **Any participant silently saved half a receipt** | Build regardless of count. A number that is quietly wrong in the books is worse than a number the owner could not enter at all. |

Why a rule rather than a feeling: sari-sari restock receipts are short, and the
long-receipt problem *feels* bigger than the market may make it. This change
touches the schema, the upload API, the OCR pipeline, both clients, the confirm
screen and file cleanup — and the frontend still has no render harness, so none
of it is automatically verifiable. That is a lot of unverifiable surface to add
to a financial app on an assumption.

**Also record, and act on separately:** if participants photograph two receipts
together, the existing `looksLikeMultipleReceipts` warning is the fix and it is
already shipped. Do not conflate the two problems.

---

## 2. Phase 0 — Verified facts & allowed APIs

Read from source on 2026-08-04. **Do not assume APIs beyond this list.**

### Schema — `backend/prisma/schema.prisma`
```prisma
model ReceiptScan {                                    // line 239
  id Int @id
  businessProfileId Int?                               // nullable, onDelete: SetNull
  imageFile   String @db.VarChar(255)                  // NOT NULL  ← the constraint
  extractedDate DateTime? @db.Date
  extractedVendor String? @db.VarChar(150)
  extractedDescription String? @db.VarChar(255)
  extractedAmount Decimal? @db.Decimal(12,2)
  confirmationStatus String @default("Pending")        // "Pending" | "Confirmed"
  rawText String? @db.Text
  visionAssisted Boolean @default(false)
  ocrConfidence Int?
  items ReceiptScanItem[]
  expenseRecords ExpenseRecord[]
}
model ReceiptScanItem { receiptScanId, lineNumber, name, quantity, unitPrice, amount, categoryId, expenseRecordId, addedByOwner, extractedByVision }
```

### Backend entry points
```
POST /api/v1/records/receipts            receipt.routes.ts:21
  uploadReceiptImage.single("file")      upload.middleware.ts:6
  limits: 10MB, mimetypes jpeg|png|webp
```
```ts
// receiptScan.service.ts:280
uploadAndScan(userId, input: { businessProfileId, buffer, mimetype, originalname })
  → uploadReceiptImage(profileId, buffer, mimetype, originalname)  // storage.service.ts:47
  → extractReceipt(buffer)                     // ocr.service — per-word confidences
  → parseReceiptFields(text) / parseLineItems(text)
  → rescueWithVision(input, parsed, items, ocr) // receiptScan.service.ts:413
  → snapVendorToHistory(profileId, text, vendor)
  → assessImageQuality(buffer)                 // lib/imageQuality.ts
```

### The vision call — `visionOcr.service.ts:167`
```ts
extractReceiptWithVision(buffer, mimetype)
body.contents[0].parts = [ { inlineData: { mimeType, data: base64 } }, { text: PROMPT } ]
generationConfig: { temperature: 0, maxOutputTokens: 2000, responseMimeType: "application/json" }
TIMEOUT_MS = 20_000, MAX_ITEMS = 100
```
**`parts[]` accepts multiple `inlineData` entries.** N pages cost ONE call, not N.

### Storage & cleanup
```ts
uploadReceiptImage(profileId, buffer, mimetype, originalname) → path   // storage.service.ts:47
signedReceiptImageUrl(path) → string | null                            // 10-min TTL, null on failure
deleteReceiptImage(path) → boolean                                     // never throws
cleanUpReceiptScanIfOrphaned(receiptScanId)                            // lib/sourceCleanup.ts:36
  ↑ deletes scan.imageFile ONLY. Must delete every page once pages exist.
  ↑ skips scans whose confirmationStatus !== "Confirmed" — a pending scan is
    someone mid-review, not an orphan.
```

### Reconciliation — the safety net this plan leans on
```ts
reconcileItems(text, items, total)   // ocr.service.ts:850
  → { itemsTotal, total, difference, reconciled, reason }
  reasons: "exact" | "matches-subtotal" | "explained-by-adjustment" | "unexplained" | "not-comparable"
```
Already detects: items short of the total (**missing middle page**), items over
the total (**overlapping photos double-counting**). No new detector needed for
either — see Phase 3.

### Clients
```
web:    web/src/pages/ScanReceipt.tsx      — single <FileInput>, one POST
mobile: mobile/src/screens/RecordsScreens.tsx:1109 upload(asset)
        ImagePicker.launchCameraAsync({ quality: 0.7, mediaTypes: ["images"] })
        FormData takes { uri, name, type } — NOT a Blob; no File API in RN
        origin panel: mobile/src/components/RecordOrigin.tsx (photo + CSV link shipped)
```

---

## 3. Phase 1 — Storage: a scan can have pages

**Goal:** the database can hold N images per scan. No UI change, no behaviour
change. Shippable and invisible on its own.

```prisma
model ReceiptScanPage {
  id            Int    @id @default(autoincrement()) @map("ReceiptScanPage_ID")
  receiptScanId Int    @map("ReceiptScan_ID")
  pageNumber    Int    @map("ReceiptScanPage_Number")
  imageFile     String @map("ReceiptScanPage_ImageFile") @db.VarChar(255)
  rawText       String? @db.Text
  ocrConfidence Int?
  receiptScan   ReceiptScan @relation(fields: [receiptScanId], references: [id], onDelete: Cascade)
  @@unique([receiptScanId, pageNumber])
  @@index([receiptScanId])
}
```

**Migration keeps `ReceiptScan.imageFile` as the page-1 cover.** It is NOT NULL
and read by `signedReceiptImageUrl`, the origin panels and cleanup; making it
nullable in the same change means touching all of them at once. Backfill
`ReceiptScanPage` from it instead, leave it in place, and let each caller move
over in its own commit.

**The trap:** `cleanUpReceiptScanIfOrphaned` deletes `scan.imageFile` only.
The moment pages exist it must delete all of them or every page after the first
is orphaned in Storage forever — silently, because `removeObject` never throws.
`tests/integration/sourceCleanup.test.ts` is where that gets proven.

**Done when:** migration applies, backfill verified against existing scans, the
cleanup test asserts every page is deleted.

---

## 4. Phase 2 — Capture: more than one photo per scan

**Goal:** both clients can send N images; the server reads them in order.

### API
`POST /records/receipts` takes `uploadReceiptImage.array("files", 8)` alongside
the existing `.single("file")` shape, or a new endpoint — decide at the time.
**Cap at 8 pages.** A receipt needing nine photographs is a scanning problem,
not a receipt.

### Pipeline
- Tesseract per page; **concatenate `rawText` in page order** — no image
  stitching. Stitching duplicates items where photos overlap, and a silently
  doubled ₱1,480 is exactly the failure the rest of this codebase avoids.
- Vision rescue: all pages in one `parts[]` array, one billed call.
- `assessImageQuality` per page → the client can flag *which* page is blurry.
- `parseReceiptFields` / `reconcileItems` run on the concatenated text
  unchanged. The total is on the last page; items span pages; concatenation
  preserves both.

### Ordering
Page order is the client's assertion, not something the server infers. Trust it,
record it, and let the review screen fix it.

**Done when:** a 3-page receipt produces one scan, one item list in printed
order, and one total.

---

## 5. Phase 3 — The two flows

**Default stays one photo = one receipt.** Long receipts are the exception; the
common path must not gain a step. This is what makes accidental merging nearly
impossible — combining requires an explicit action after already photographing.

### Mobile — capture session
```
shoot page 1 → preview → [ Retake ] [ + Add page ] [ Use this receipt ]
                                  ↓
  filmstrip: [1] [2] [3] [+]   drag to reorder, × to remove
  ⚠ Page 2 looks blurry — Retake?        ← assessImageQuality, per page, at capture
  [ Scan these 3 pages ]
```
Run the blur check **at capture**, not after upload: catching page 2 while the
camera is still open costs a tap; catching it after costs an OCR pass, a Gemini
call and a wrong set of figures.

### Web — upload with mandatory disambiguation
1 file → current flow, untouched. 2+ files → a question that must be answered:

```
You added 4 photos.
  ○ One long receipt (4 pages)
  ● Four separate receipts        ← DEFAULT
  ⚠ We found 4 total lines — these look like separate receipts.
```
**Default to "separate".** A mis-click then yields four correctable records
rather than one record silently missing three receipts of money. Wrong-but-
visible beats wrong-but-hidden in bookkeeping.

### Edge cases — mostly already solved
| Case | Detection | Source |
|---|---|---|
| Missing middle page | items short of total | `reconcileItems`, `reason: "unexplained"` |
| Overlapping photos | items exceed total | same, other direction |
| Duplicate page | near-identical adjacent `rawText` | new, trivial |
| Two receipts in one photo | two date labels | `looksLikeMultipleReceipts` — **shipped** |
| Not a receipt | no money lines | existing empty-items path |

**Done when:** each case above produces a specific sentence, not a generic one.

---

## 6. Phase 4 — Review & provenance (build only if UAT says 4+)

- Confirm screen: page strip beside the items, reusing the tab strip already in
  `RecordOriginPanel` — `Items (n)` | `Page 1` | `Page 2` …
- Origin panel: all pages, not just the cover, on web and mobile.
- Retake a single page without re-scanning the whole receipt.

---

## 7. What this plan deliberately rejects

**Stitching pages into one tall image.** Tempting — no schema change, `imageFile`
stays single. Rejected: overlapping regions double-count line items, and
per-page retake becomes impossible.

**Auto-grouping uploads with AI.** Least user effort, but a wrong grouping
corrupts financial records and cannot be explained to a shop owner. It also
contradicts the rule this codebase states at `receiptScan.service.ts:496` —
vision replaces a deterministic read *"only on an OBJECTIVE test, never a
preference."* Grouping is a judgement, not arithmetic.

**Any automatic split or merge.** The check may warn. The owner decides. They
are holding the paper.

---

## 8. Before any of this ships

The frontend has no render harness and 68 web / 73 mobile tests, none of which
render a component. Every phase above is behavioural. Either add a render
harness first, or accept that Phases 2–4 are verifiable only by hand — and say
so out loud rather than discovering it at UAT.
