# FinSight cost-first core feature implementation plan

**Prepared:** 13 September 2026

**Repository snapshot:** checkpointed runtime candidate `20d011e`

**Scope:** receipt capture, OCR and extraction, processing results, spreadsheet import, automatic expense categorization, evaluation, and privacy

**Deliverable type:** implementation plan only. No application code is changed by this document.

**Phase 0 implementation status:** the repository and migration prerequisite for Phase 1 implementation closed on 13 September 2026. The full release gate remains open for eligible consented receipts, physical-device evidence, and hosted account/backup classification. See [the Phase 0 baseline](phase-0/README.md).

## Executive decision

FinSight should keep a local-first architecture and pay for OCR only when a local result is unsafe to trust.

1. Keep the existing Android CameraX/OpenCV scanner, Sharp image processing, Tesseract.js OCR, deterministic parsers, PostgreSQL workers, and per-business correction history. These have no metered API fee and are already integrated.
2. Add Azure AI Document Intelligence `prebuilt-receipt` behind a provider adapter as an optional rescue path. At the time of this review, its F0 tier includes 500 pages per month. A separate S0 resource in Southeast Asia is about USD 10 per 1,000 prebuilt pages. It must run only for uncertain fields, suspected handwriting, or failed local extraction, with explicit consent and a hard provider-unit budget.
3. Keep the existing Veryfi integration disabled by default. Its 100-document free allowance may be considered for a controlled non-production cloud benchmark only after separate approval, but its paid plan has a USD 500 monthly minimum. That is not a sensible FinSight default.
4. Keep PaddleOCR out of the MVP production path. A non-production Phase 3 benchmark may test it as the strongest no-API-fee challenger only if the Tesseract-versus-Azure comparison records a specific failure hypothesis. Production adoption remains Post-MVP and still requires an independent gain. Use TrOCR only on detected handwritten line crops if a labeled handwriting corpus proves a benefit.
5. Keep CSV support and add free, fail-closed ClamAV scanning to every import before MVP acceptance. Add `.xlsx` only after a small, non-executing parser such as `read-excel-file` and strict OOXML validation pass the additional release gate. Reject legacy `.xls`, macro-enabled `.xlsm`, password-protected files, external links, and formula cells in MVP; keep CSV-only if that gate is not ready.
6. Replace model-first categorization with a free deterministic ladder: explicit owner rules, exact vendor and description history, normalized keyword matching, then optional classification. In MVP, only an active owner-authored rule can be High; exact history is at most Medium and a model-only result is Low. Learned/history/model promotion to High is Post-MVP, requires the profile-specific evidence gate, and needs a separate decision. New categories are never created without owner approval.

This recommendation has **USD 0 in mandatory metered API charges**. A synthetic capstone can use Supabase Free. A real-owner deployment using the current password flow should budget for Supabase Pro, currently starting at USD 25 per month, because the project requires leaked-password protection and dependable backup controls before real-user rollout. Local OCR still consumes application CPU and storage, and ClamAV consumes memory, so “free” means no license or per-call fee, not no infrastructure cost.

### Cost labels used in this plan

| Label | Meaning |
| --- | --- |
| Free | No license or metered API fee. Existing compute and storage still have a cost. |
| Free tier | No charge only within a provider quota or trial condition. The application must fail closed at the configured budget. |
| Low cost | Usage-priced and suitable as a selective fallback, not an always-on dependency. |
| Paid | Contract, minimum spend, or material recurring infrastructure is required. |

### Assumptions and corrections to the supplied brief

- The brief names Laravel 11, but the repository does not use Laravel or PHP. The current backend is Express 4 and TypeScript, with Prisma and PostgreSQL/Supabase. The clients are React/Vite and React Native/Expo. This plan follows the code, not the stale stack assumption.
- FinSight's confirmed deployment scope has one human user: one Small Business Owner account. There is no invitation, collaboration, delegated approval, administrator, staff, or bookkeeper surface. Authorization still requires the authenticated owner plus active-business ownership checks because the owner may hold more than one business profile and isolation remains a security boundary.
- Android is the scanner-first platform. iOS and Expo Go currently use an explicitly labeled manual/gallery path. Native scanner work requires development or EAS builds and physical-device testing.
- Accuracy numbers below are frozen v1 release gates, not claims about current performance. The release corpus and benchmark protocol must prove them.
- Prices and free tiers were checked on 12 September 2026 in USD and can change. Recheck the official source before enabling billing.

## 1. Assessment of the current implementation

### 1.1 Stack and operating model

| Area | Verified implementation | Planning consequence |
| --- | --- | --- |
| Backend | Express, TypeScript, Prisma, Zod, PostgreSQL, and separate API/worker processes in `backend/package.json` | Extend existing controllers, services, durable workers, and schemas. Do not introduce Laravel jobs or PHP packages. |
| Storage and auth | Supabase Auth and private Storage through a backend service-role client | Keep files private and retain the current ten-minute receipt read URLs. Never send the service-role key to either client. |
| Web | React 19 and Vite in `web/` | Use the existing result, form, status, and accessibility patterns. |
| Mobile | Expo 57, React Native 0.86, and an Android local native scanner | Native changes need a rebuilt application and a physical-device gate. |
| OCR | Sharp plus Tesseract.js, deterministic parsing, Gemini vision, and optional Veryfi | The local path exists, but configured cloud vision currently runs on every scan. Invert this to local-first rescue routing. |
| Jobs | Durable PostgreSQL-backed receipt, import, and analysis workers | Reuse the existing lease, heartbeat, retry, and idempotency conventions. |

### 1.2 Receipt capture

The current Android implementation is already materially beyond a basic camera upload:

- `mobile/modules/finsight-receipt-scanner` uses CameraX and OpenCV locally. Standard mode detects a document, waits for stable geometry, rectifies it, and returns unenhanced and conservatively enhanced evidence.
- Long mode registers overlapping frames, accepts only constrained near-vertical movement, and creates one bounded composite. It rejects uncertain movement instead of guessing a seam.
- The current limits include a 90-second session, 80 accepted keyframes, a 12-megapixel composite, a 16,000-pixel height, and a 10 MB output limit. These are documented in `docs/custom-native-receipt-scanner.md`.
- Review supports gallery fallback, crop, rotation, quality checks, retake, ordered pages, and explicit approval before upload.
- The server supports multi-page uploads through `POST /records/receipts`, plus separate quality, edge-detection, and transform endpoints in `backend/src/routes/receipt.routes.ts:26`.
- Android implementation and emulator tests exist, but the latest QA handoff still requires physical receipts, physical-device lifecycle checks, TalkBack, low-memory testing, and authenticated capture-to-confirm evidence.

Important limitations are already visible in source:

- Standard native capture saves the perspective-warped analysis frame, downscaled to at most 1,600 pixels, rather than taking a separate full-resolution still. Its “original” is an unenhanced rectified image, not the untouched camera frame.
- Long mode emits the final unenhanced/enhanced mosaic but does not retain source segments, seam confidence, or a per-segment fallback.
- Android native guidance covers geometry, movement, brightness, and focus. The manual iOS/Expo path has only a static guide and explicit post-capture checks.
- There is no dedicated glare metric, curved-paper dewarping, semantic receipt classifier, or proven shadow/denoise recovery. Conservative illumination adjustment is present and must remain evidence-gated.
- A native peak-memory risk and a manual-capture request that can remain pending if analysis frames stop are documented but not closed by real-device evidence.

The right next step is validation and targeted hardening, not another scanner rewrite or a paid capture SDK.

### 1.3 OCR, extraction, and receipt results

The current pipeline already provides:

- asynchronous scan creation, polling, durable retry, heartbeat recovery, and `POST /records/receipts/:id/retry` without re-upload;
- original and processed image persistence per page;
- OCR of candidate images with objective candidate selection;
- per-page raw text and confidence, receipt-level confidence, warning codes, extractor versions, and field evidence;
- multi-page seam handling, repeated-page warnings, and arithmetic reconciliation;
- vendor, date, amount, item, quantity, unit-price, and per-item category output;
- an editable web and mobile confirmation flow that records owner corrections in `ReceiptFieldCorrection`;
- atomic confirmation into one or more expense records.

The local engine defaults to English and creates/terminates a fresh Tesseract worker for every candidate image. One page can read original and processed variants, so long receipts multiply startup cost. `backend/eng.traineddata` exists, but the current worker does not set a local language-data path and the Dockerfile does not copy that file. A cold worker can therefore fetch missing data from Tesseract's default remote source or fail when egress is blocked. MVP must bundle and checksum every configured language file, use a read-only local path, and prove an egress-disabled cold start. Keep the simple worker lifecycle for MVP safety, measure it, and consider a bounded reusable worker pool only after the dedicated worker boundary is real.

The current route set does not include whole-scan deletion, abandoned-draft cleanup, scan history/listing, or page replace/reorder/reprocess. Those recovery operations should be added before presenting drafts as durable user-controlled records.

Two architectural gaps precede feature expansion:

- Scan upload and retry create durable jobs, but also start `claimAndProcessScan()` from the API process in `backend/src/services/receiptScan/worker.ts:170` and `:578`. The separately deployed worker is therefore not the only OCR consumer, and global concurrency/memory is not bounded at one worker boundary.
- Multipart input can contain eight processed files plus eight originals at 10 MB each. Multer holds them in memory, while `nginx/nginx.conf:4` allows about 88 MB. The application, proxy, and tests disagree about the real aggregate contract.

Cloud routing is also inverted from the desired cost posture. In `backend/src/services/receiptScan/worker.ts:300`, configured Gemini vision is attempted on every scan and Veryfi can run on every page. The local Tesseract/parser result should be evaluated first, with cloud reserved for a measured rescue condition.

The schema in `backend/prisma/schema.prisma:736` has `ReceiptScan`, `ReceiptScanPage`, `ReceiptScanItem`, and `ReceiptFieldCorrection`. It does not yet expose all requested structured fields as durable typed values. Invoice number, transaction time, currency, subtotal, tax, discounts, payment method, handwriting status, and field bounding polygons are incomplete or held only in raw/provider-specific evidence.

The result interfaces have related usability gaps. Evidence contains page/source text but no region coordinates. Mobile shows small cropped page thumbnails with no full-size zoom, which is especially weak for a tall panorama. Web shows an enlarged image but only page 1. Item name, quantity, unit price, and line amount are read-only; owners must delete and recreate a bad OCR line. Web has no visible cancel while waiting, and its “Rescan” path can return the accepted cached result rather than initiate fresh OCR.

### 1.4 CSV import

The import implementation is mature for CSV:

- UTF-8/BOM handling, delimiter detection, header checks, row and cell validation, date-format confirmation, mapping, corrections, preview, and duplicate warnings;
- a 5 MiB (5,242,880-byte file-body) upload cap and a 30,000-row cap;
- synchronous processing through 2,000 rows, then a durable worker using 1,000-row commit chunks;
- persisted idempotency, file hash, processing status, counts, failure stage, attempts, heartbeat, checkpoint, mapping metadata, and a bounded result summary;
- web and mobile mapping, preview, correction, polling, partial-success, and summary states.

The current limitations are important:

- only `.csv` is accepted in `backend/src/middleware/upload.middleware.ts:20`;
- the full CSV is parsed and validated in the request before a large import is handed to the worker, so large preview/confirm requests can still occupy the Node event loop;
- preview and confirm upload the file separately instead of referring to one staged object;
- the result summary caps row details, so FinSight cannot produce a complete error report or reprocess only failed rows;
- there are no reusable mapping templates or guarded undo operation;
- MIME type and extension checks are not content identification, and there is no malware scanner.

### 1.5 Automatic categorization

Current categorization has good safety properties:

- all category queries are scoped to the active business profile;
- exact normalized description/vendor history is tried before a model for manually entered expenses;
- receipt-item examples come only from confirmed scans, not the model's own unreviewed output;
- a model may return only an existing category or `UNCATEGORISED`;
- a proposed new category is owner-approved and never silently created;
- model failure cannot fail receipt processing.

The missing layer is a measurable deterministic rule engine. There are no explicit owner vendor rules, keyword priorities, ranked candidates, calibrated category confidence, decision-version records, or outcome metrics. The current model result is effectively a single choice rather than an explainable high/medium/low decision.

Category model calls also have no abort timeout. Receipt-item history is sent as few-shot prompt context, but it is not first applied as the free deterministic exact-match layer already used elsewhere in FinSight.

Current duplicate protection is split. Upload idempotency prevents replay of the same client key, and exact expense duplicate detection compares profile/date/amount/description. Near-duplicate analysis adds vendor/category context after save but is disabled by default. Different upload keys for the same receipt do not share an image/content fingerprint, and two distinct scans can race through exact confirmation because that path does not take the existing semantic advisory lock.

### 1.6 Evidence level at planning time and after Phase 0

At planning time, `docs/qa-reports/FINSIGHT-QA-RETEST-20260912-50d7a1f.md` recorded 1,983 backend tests, 685 web unit tests plus 10 Playwright tests, and 982 mobile tests passing on the dirty tree. That is now HISTORICAL evidence.

The current Phase 0 run is recorded in `docs/phase-0/README.md`: 1,983 backend, 685 web, 10 mocked Playwright, 983 mobile, and 13 ML-worker tests passed for checkpointed candidate `20d011e`, with one expected backend sentinel skip. The migration chain replayed from empty, all 39 successful hosted migration checksums match their tracked local files, and the hosted read-only audit verified schema equivalence, deny-all direct client table/sequence access, RLS, Storage visibility, and signed-URL expiry. Account/backup classification, eligible consented receipts, and physical-device evidence remain open release gates; they do not block local Phase 1 implementation.

Focused read-only audits for this plan ran 222 receipt unit tests, 187 receipt integration tests, 149 focused mobile receipt tests, and 51 focused web receipt tests successfully. Provider, Auth, Storage, and camera inputs are substantially mocked in those suites, so this is regression evidence, not live OCR or physical capture evidence.

Automated coverage does not close these acceptance gaps:

- the OCR corpus is private/gitignored and unsuitable as an unattended CI gate in its present form;
- synthetic images and emulator scenes do not prove performance on real receipts;
- the latest scanner release gate records no eligible consented samples;
- physical-device camera, permission, lifecycle, thermal, and low-memory behavior remains unverified;
- hosted backup/restore, account-data classification, leaked-password remediation for real credentials, and private single-owner signup closure remain open;
- live OCR/provider, capacity, browser/screen-reader, and section 9 cohort-based UAT checks remain open.

The generated OCR report records 67% date, 73% vendor, 67% amount, and 51% all-three success over 73 images. Its manifest is not independently verified owner truth, and QA found inconsistencies in the `real` and Philippine provenance labels. Synthetic/degraded groups perform much better. Treat these figures as a parser baseline only, not production or Philippine-market accuracy.

## 2. Identified weaknesses and risks

| Priority | Gap | Consequence | Scope |
| --- | --- | --- | --- |
| P0 | Any new table or object path could omit active-business ownership checks or deny-all RLS | Cross-business financial or document exposure | MVP release blocker |
| P1 | API upload/retry can execute OCR eagerly even though a separate durable worker exists | API memory/latency spikes, duplicate concurrency paths, and restart risk | MVP first task |
| P1 | Paired multipart uploads can buffer roughly 160 MB before decode while nginx allows about 88 MB | Proxy rejection or backend memory exhaustion | MVP first task |
| P1 | Tesseract language data is not bundled/configured in the production image | A cold “local” OCR run can require outbound network or fail without it | MVP first task |
| P1 | Physical long-scan and standard-scan performance is not proven on the declared low-memory and mainstream Android targets or the section 9 receipt cohorts | Cropped totals, duplicated lines, crashes, or false confidence | MVP release blocker |
| P1 | Requested structured fields and bounding regions are incomplete | Users cannot review all financial values or see their source region | MVP |
| P1 | Provider rescue has no single cost/privacy policy; Veryfi can be enabled with no finite limit, checks quota non-atomically, and counts a scan while requesting per page | Concurrency can overspend and usage records can undercount billing units | MVP |
| P1 | Import result details are bounded JSON rather than durable row outcomes | Incomplete error reports and unsafe “retry failed only” behavior | MVP |
| P1 | Large files are still synchronously parsed on request entry | Timeouts and event-loop pressure despite a background insert worker | MVP |
| P1 | Import content identification and malware controls are absent; workbook-specific archive controls are also absent | Malicious uploads, parser abuse, archive bombs, or hostile Office content | ClamAV/content checks required for CSV MVP; full OOXML controls required before `.xlsx` |
| P2 | Category confidence is not calibrated and there are no user-authored rules | Incorrect automatic assignments and poor explainability | MVP |
| P2 | Extraction confidence from different providers is not comparable | A high raw provider score can still be a wrong financial field | MVP |
| P2 | Receipt-level duplicate logic lacks a durable, reviewable candidate record | Accidental double entry or opaque duplicate warnings | MVP |
| P2 | Two distinct scans of the same receipt can race through confirmation without the existing semantic advisory lock | Duplicate expense records despite same-scan idempotency | MVP |
| P2 | Result evidence has no coordinates; mobile cannot inspect a long image and web shows only page 1 | Corrections are guesswork rather than evidence-led review | MVP |
| P2 | Extracted line-item text and money are not editable in place | Owners must delete/recreate OCR lines and lose clean correction evidence | MVP |
| P2 | Raw provider error text can be persisted/returned and opaque provider bodies can enter logs | Sensitive content disclosure and weak support contract | MVP |
| P2 | A tracked Veryfi benchmark artifact contains raw provider payloads and signed asset URLs | Unnecessary exposure and long-lived repository data | MVP security cleanup |
| P2 | iOS lacks scanner parity | Manual capture burden and platform inconsistency | Post-MVP unless iOS is a capstone requirement |
| P2 | No explicit retention policy or automated enforcement for original, processed, failed, and provider-derived data | Excess storage and unclear privacy expectations | MVP policy and automated enforcement |
| P3 | No complete per-stage audit history | Harder support diagnosis and provider comparison | Post-MVP |

## 3. Recommended architecture and end-to-end workflows

### 3.1 Design rules

1. Source evidence is immutable. For Standard/manual/gallery capture, this means the full-resolution source still. For continuous capture, it means the accepted segment set or a clearly labeled unenhanced composite under the documented retention policy. Rectified and enhanced variants are derived artifacts.
2. A receipt becomes a financial record only after an authenticated owner confirms it.
3. Always-critical fields are vendor, date, source currency, and total. Subtotal, tax, discount, tip, and service charge are conditionally critical when printed or used in reconciliation. A field proven not applicable does not lower the review band.
4. Provider output is untrusted input. Parse it through a versioned Zod schema, normalize it, run the same financial checks, and record the source/version.
5. Local processing always runs first. A cloud call is a narrow rescue, not the main route.
6. Every job is profile-scoped, idempotent, retryable, and safe to resume after a worker crash.
7. Do not display invented percentages. Show the named current stage and a determinate count only when the system has a real denominator, such as page 2 of 4 or row 8,000 of 30,000.

### 3.2 Receipt workflow

```text
Capture or select
  -> on-device boundary, stability, lighting, blur and completeness guidance
  -> owner approves original/processed page set
  -> authenticated, idempotent upload to private Storage
  -> durable ReceiptScan created
  -> quality check and conservative enhancement
  -> local OCR per page
  -> deterministic field and line-item extraction
  -> arithmetic, date, currency and vendor validation
  -> optional consented Azure rescue for uncertain fields/pages
  -> normalize and choose evidence-backed field candidates
  -> receipt-level duplicate candidate search
  -> deterministic category rules and ranked suggestions
  -> editable evidence-led review
  -> atomic confirmation into expense records
  -> correction and decision feedback retained per business
```

Recommended machine stages are `RECEIVED`, `QUALITY_CHECKED`, `ENHANCED`, `OCR_LOCAL`, `OCR_RESCUE`, `EXTRACTED`, `VALIDATED`, `DUPLICATE_CHECKED`, `CATEGORIZED`, `READY_FOR_REVIEW`, and `FAILED`. `OCR_RESCUE` is skipped rather than simulated when no cloud call is made. Keep machine stage separate from the existing owner confirmation/review status.

Upload and retry must enqueue only. A dedicated receipt worker with configured concurrency `1` for MVP is the sole consumer of OCR/provider work. Replace Multer memory storage with bounded temporary-file or streaming ingestion. Keep 10 MiB per object and eight pages, but enforce 80 MiB across all source/derived objects; configure nginx above that only for multipart overhead and test the exact boundary. Validate/store pages sequentially and clean temporary files on every exit. The worker downloads, validates, and processes one page/candidate at a time rather than reconstructing every source/derived image in one in-memory object. This keeps the current multipart contract and upload progress without adding a new receipt-upload subsystem.

Failure behavior:

- Upload failure: preserve the local selection and retry the same idempotency key.
- Quality failure: never destroy the capture. Offer retake, edit/crop, or “Use anyway” with review forced.
- Local OCR failure: retain the image, offer cloud rescue if consented and within budget, otherwise open manual entry.
- Cloud failure or budget exhaustion: continue with the local result and show why review is required.
- One-page failure in a multi-page receipt: MVP retries the whole receipt from stored bytes while reusing any successfully persisted provider result. Page-only revision/reprocessing is Post-MVP because seams, totals, items, categories, and duplicate candidates are receipt-wide.
- Save failure or an unknown response: preserve all edits, reload the scan's confirmation state, and retry only if it remains Pending. The existing conditional Pending-to-Confirmed transition is the MVP duplicate-write guard.

Batch receipt capture is explicit. The owner chooses “One long receipt” or “Separate receipts.” A `ReceiptCaptureBatch` contains several ordered `ReceiptScan` IDs, while each scan keeps its own pages, OCR job, total, duplicate candidates, review, retry, and confirmation. Mobile assigns a distinct `receiptGroupId` at each “Next receipt” boundary; web maps its existing separate-receipt groups to the same contract. Upload groups sequentially so a batch does not recreate the aggregate memory spike.

### 3.3 Long receipt workflow

Keep the current guided continuous capture on supported Android builds:

1. Require a detected top edge before accepting the first frame.
2. Give live direction for overlap, lateral drift, speed, light, and stability.
3. Register downscaled frames against a bounded in-memory accepted-frame manifest during the active session. MVP persists the bounded unenhanced/enhanced composite, not the source segment set.
4. Reject reverse, weak, or ambiguous matches. Do not infer a seam from repeated equal-price rows alone.
5. Require recent bottom-edge evidence before automatic completion. Manual Finish before that point must be labeled “May be incomplete.”
6. OCR the accepted composite and retain bounded aggregate seam metrics in capture metadata. Post-MVP source-segment persistence enables segment boundaries, ordered segment OCR, and targeted rescan when reconstruction confidence is low.
7. Keep ordered multi-page manual capture as the fallback. Do not add a paid long-receipt SDK for MVP.

Image stitching remains conditional. For MVP, the composite is authoritative only if it passes the labeled long-receipt gate; otherwise FinSight directs the owner to ordered multi-page manual capture and does not label the continuous scan complete. Ordered segment OCR with overlap de-duplication is a Post-MVP candidate because it requires retained segment provenance and a new result contract.

### 3.4 Import workflow

```text
Upload once
  -> content signature, size, encoding, archive and malware checks
  -> private staged object plus durable import batch
  -> asynchronous header/sample parse
  -> mapping and date/currency confirmation
  -> full validation into durable row results
  -> lifecycle status plus warning/duplicate/error findings
  -> mutually exclusive derived review buckets
  -> owner confirms import policy
  -> idempotent chunked writes and progress counts
  -> downloadable sanitized error report
  -> corrected-row reprocess
  -> guarded undo after Post-MVP eligibility checks
```

The upload endpoint should return a batch ID immediately. Preview and confirmation should reference that batch rather than uploading the same bytes twice. Parsing, not only insertion, moves to the worker for large files and all `.xlsx` files.

For header detection, inspect only a bounded leading window of non-empty rows and score uniqueness, text-to-number ratio, and known aliases for date, description, amount, vendor, category, and record type. Show the proposed header row and skipped preamble for owner confirmation. A low-confidence result must ask the owner rather than silently discard rows. Normalize dates with the existing explicit calendar parser, monetary values using the currency's minor-unit rule, ISO currency codes, and categories against the active profile's case-insensitive names. MVP imports PHP bookkeeping amounts only; non-PHP rows enter Rejected/Needs conversion rather than silently treating foreign values as pesos.

### 3.5 Categorization workflow

Apply candidates in this order:

1. explicit owner vendor rule;
2. exact normalized description plus vendor from confirmed history;
3. exact normalized vendor rule learned from repeated owner corrections;
4. owner keyword rule with priority and exclusions;
5. token similarity against confirmed descriptions within the same business;
6. optional model or local embedding classifier using the business type, vendor, normalized description, amount band, currency, and nearby receipt-item context, restricted to the current category IDs;
7. `Uncategorized` with ranked suggestions.

Rules produce an explanation such as “Your vendor rule” or “Matched your confirmed purchase history,” not a raw score. When a support count is shown, it comes from the current profile query. Learned rules are proposed after repeated consistent corrections and become active only after owner approval.

Business type and amount are tie-break/context features, not tenant-shared truth. Neither can create a High decision alone. Do not pool identifiable descriptions or correction examples across business profiles. If a future global model is trained, it needs separate consent, de-identification, governance, and evaluation; it is outside MVP.

Any external category call has a 5-second abort deadline and no inline retry during receipt processing. Timeout, invalid output, or circuit-open state returns deterministic history/rules or Uncategorized and allows the scan to continue.

## 4. Technology comparison

### 4.1 Capture and image processing

| Technology | Cost | Offline/privacy | Fit for FinSight | Decision |
| --- | --- | --- | --- | --- |
| Existing CameraX + OpenCV module | Free; device compute only | On-device | Already supports stable auto-capture and continuous long-receipt registration; full control but FinSight owns testing and maintenance | **MVP default on Android** |
| Google ML Kit Document Scanner | Free, no metered API fee | On-device after Google Play Services download; scanner metrics/update checks can contact Google | Strong standard multi-page document capture, fixed provider UI, limited custom long-sweep control | Keep as a benchmarked fallback only if the custom standard mode fails device gates |
| Apple VisionKit document camera | No metered API fee; Apple build/distribution requirements remain | On-device | Best native route to iOS standard multi-page capture | **Post-MVP iOS** |
| Veryfi Lens | Paid, quote required | Third-party SDK and service terms | Commercial capture features, but cost and lock-in conflict with the capstone goal | Do not adopt |

OpenCV 4.5 and later is Apache 2.0 licensed. CameraX and the Android implementation have no per-scan fee. These facts do not eliminate engineering and device-lab cost.

### 4.2 OCR and receipt extraction

Prices are provider list prices or official examples checked on 12 September 2026. They exclude taxes, network, Storage, and application compute.

| Option | Current cost signal | Structured receipts and handwriting | Privacy/offline | Expected speed, integration, and decision |
| --- | --- | --- | --- | --- |
| Tesseract.js | Free, Apache 2.0 | Good baseline for printed text; its own FAQ does not support handwriting, and it has no receipt schema | Fully local only after traineddata is bundled; the current cold path can use a remote default | Already integrated, but language-data startup and per-image worker creation make cold/long scans costly. Bundle checksummed language data and keep it as the mandatory first pass. |
| PaddleOCR | Free, Apache 2.0; self-host compute | Strong multilingual/document candidate; handwriting benefit must be measured on FinSight data | Self-hosted and can be private/offline | Hardware/model dependent and high integration effort through Python/Paddle or ONNX. Permit a Phase 3 non-production sidecar benchmark only after a recorded Azure/Tesseract failure hypothesis; production adoption is Post-MVP. |
| TrOCR | Open source/model license depends on checkpoint; CPU/GPU cost | Designed for printed or handwritten line recognition, not whole receipt structure | Self-hostable | Heavy model plus detector/cropper makes this the highest local effort. Use only on detected line crops after a labeled handwriting benchmark. |
| Google Cloud Vision | First 1,000 OCR units/month free, then about USD 1.50/1,000 | Text and handwriting OCR, but no receipt-specific schema | Cloud processing | Network-bound, medium adapter effort, and cheap for raw OCR. Benchmark latency because FinSight still owns parsing. |
| Google Document AI Expense Parser | About USD 0.10 per document of up to 10 pages; OCR processor has a separate free allowance | Receipt entities and line items; published language support varies by processor version | Cloud processing | Network-bound and medium integration effort. Capable but roughly ten times the per-page cost of Azure/AWS examples. |
| Azure AI Document Intelligence `prebuilt-receipt` | F0: 500 pages/month; Southeast Asia retail meter about USD 10/1,000 pages | Receipt fields, line items, per-field confidence, printed and handwritten receipt support | Cloud processing; F0 is limited to the first 2 pages/request and 4 MB | Network-bound, medium adapter effort, and F0 permits one analyze request/second. **Recommended optional rescue** after a p95 benchmark. |
| AWS Textract AnalyzeExpense | New-account free tier: 100 pages/month for 3 months; Singapore price about USD 0.01/page | Summary and line-item expense fields; expense/handwriting support is English-only | Cloud processing | Network-bound, medium-to-high effort for async S3/SNS documents. Benchmark only if Azure fails regional/data requirements. |
| Veryfi Receipt OCR | 100 documents/month free; listed paid receipt rate USD 0.08 with USD 500 monthly minimum | Specialized receipt schema, line items, confidence/bounding regions | Cloud processing and vendor retention terms | Lowest integration effort because an adapter exists, but synchronous calls can outlive a 120-second gateway timeout while still billing. Use free benchmark only. |
| Gemini vision rescue | Free and paid developer tiers vary by model | Flexible extraction but not a dedicated financial-document contract | Cloud; free-tier data terms need special care | Existing integration lowers effort, but latency/output stability must be measured. Keep off for real receipts unless paid-tier terms and evidence justify it. |

No provider is accepted based on marketing claims. Azure is the cost/function leader to test, not a declared accuracy winner.

For a production paid tier and one-page documents, the published usage examples imply this comparison. A free tier is a separate resource/eligibility condition, not a discount that should be assumed on a paid account.

| Option | 100 pages/docs | 1,000 | 5,000 | Important condition |
| --- | ---: | ---: | ---: | --- |
| Tesseract/PaddleOCR/TrOCR | USD 0 API fee | USD 0 | USD 0 | FinSight pays its own compute |
| Google Vision OCR | USD 0 | USD 0 | about USD 6 | First 1,000 units/month free, then tiered |
| Google Document AI Expense | USD 10 | USD 100 | USD 500 | One count covers up to 10 pages of one document |
| Azure prebuilt receipt S0 | about USD 1 | about USD 10 | about USD 50 | F0 instead provides up to 500 free pages with tighter limits |
| AWS AnalyzeExpense | about USD 1 | about USD 10 | about USD 50 | Free 100 pages/month is only for eligible new accounts for 3 months |
| Veryfi receipt | USD 0 on Free | at least USD 500 | at least USD 500 | Paid Starter has a USD 500 monthly minimum |

Azure documents thermal receipt formats, printed and handwritten extraction, field confidence/source regions, and Filipino among supported receipt languages. Those capabilities make it relevant to FinSight, but PHP currency symbols, VAT layouts, local handwriting, and actual accuracy still require the same-corpus benchmark. Azure documents regional encryption and automatic input/result deletion after 24 hours; v4 supports explicit result deletion.

Google Vision is cheaper for raw OCR and states that submitted content is not used to train its models, but it has no receipt schema and no documented Singapore OCR endpoint. AWS expense/handwriting support is English-only and AWS requires an organization policy to opt out of AI service improvement. Veryfi supports immediate `auto_delete`, which must be enabled in any benchmark because its privacy policy otherwise permits model improvement uses unless the business opts out.

Azure is not a complete substitute for FinSight's schema:

| Requested result | MVP source |
| --- | --- |
| Merchant, transaction date/time, subtotal, tax, tip, total, items, quantity, unit price, item total | Local parser first; Azure's documented receipt fields may rescue a candidate |
| Receipt/invoice number | Existing local receipt-detail parser plus owner review; evaluate Azure prebuilt-invoice separately only if invoice documents are in scope |
| Discounts and service charges | Local layout/arithmetic rules plus owner review unless the selected provider version documents and benchmarks the exact field |
| Payment method | Local keyword normalization plus owner review; never infer card/account identifiers |
| Handwritten notes | OCR text/line-crop experiment plus required focused review; Azure receipt structure is not assumed to return a notes field |
| Expense category | FinSight's profile-scoped rule/history engine only; no OCR provider chooses the authoritative category |

For local Tesseract results, map selected field evidence back to its token/line boxes. When no reliable mapping exists, return `REGION_UNAVAILABLE` with source text and lower the evidence band rather than silently omitting the region.

### 4.3 Import and categorization components

| Need | Free-first choice | Reason | Alternative/fallback |
| --- | --- | --- | --- |
| CSV parsing | Existing `csv-parse` | Integrated and tested | None needed |
| `.xlsx` reading | `read-excel-file` with strict schema, decimal-safe `parseNumber`, and pinned lockfile | MIT, reads OOXML without running macros, smaller scope than a workbook editor | Keep CSV-only if the security/worker gate is not ready |
| Malware scanning | ClamAV/`clamd`, signatures updated by `freshclam` | GPLv2 and no per-file fee | Managed scanner only if self-host resource use is unacceptable |
| Encoding | Strict UTF-8, UTF-8 BOM, UTF-16 LE/BE BOM; explicit rejection of ambiguous legacy encodings | Predictable and testable, avoids silent character corruption | Let the owner choose an encoding from a short allowlist after preview |
| Category rules | TypeScript deterministic service plus PostgreSQL tables | No model cost, explainable, profile-scoped | Manual category selection |
| Fuzzy history | Normalized tokens first; optional PostgreSQL `pg_trgm` after measurement | No external data transfer | Exact matching only |
| Embeddings/ML | None in MVP | Sparse per-profile labels do not justify complexity | Post-MVP local embedding or classifier in shadow mode |

## 5. Final technology recommendation and justification

### 5.1 MVP technology set

- **Capture:** existing Android CameraX/OpenCV scanner, manual/gallery fallback elsewhere.
- **Image processing:** current on-device OpenCV and backend Sharp policies. Add only transformations that improve the frozen corpus without critical-field regression.
- **OCR:** Tesseract.js first on every page, with each configured traineddata file pinned, checksummed, copied into the production image, and loaded from a read-only local path.
- **Structured extraction:** existing deterministic parsers extended for invoice number, time, currency, subtotal, tax, discount, payment method, and notes.
- **Cloud rescue:** Azure `prebuilt-receipt`, disabled until its benchmark passes. Phase 0 approves at most 100 page units for the initial non-production benchmark on a verified F0 resource; no S0 paid benchmark is approved. Only after a passing benchmark and a separate promotion decision may the automatic F0 application cap rise to the 450-page candidate, with warnings at 75% and 90% and a hard block at 100%. Keep the remaining provider allowance outside the automatic budget. Use a dedicated resource or reconcile other callers because the FinSight cap cannot govern usage outside FinSight.
- **Cloud fallback:** manual review. Veryfi's free allowance may be considered for a controlled non-production cloud benchmark only after separate approval, never as an automatic second cloud call.
- **Imports:** keep CSV as the only advertised format, but add fail-closed ClamAV/content checks for every upload plus durable row-result storage before MVP acceptance; enable `read-excel-file` for `.xlsx` only with the additional complete OOXML/precision gate.
- **Categorization:** deterministic profile-scoped rules/history. Existing Gemini/OpenRouter classification becomes optional last-resort suggestion only, not the source of “high confidence.”
- **Platform:** current Supabase/PostgreSQL, private Storage, Express workers, React web, and Expo mobile.

Why this is the best fit:

- It preserves the most tested code and adds no mandatory paid service.
- It spends scarce free cloud quota only where the local result needs help.
- Azure currently offers the most generous relevant free tier among the managed structured receipt options compared here, while its separate S0 resource has a low published usage price.
- FinSight can disable Azure without disabling capture, import, manual review, or saving.
- Provider-independent normalized output prevents a future price or policy change from forcing a client rewrite.

The rescue gate should fire only for a missing/invalid total, unreconciled financial fields, calibrated low critical-field confidence, suspected handwriting, or an explicit owner retry. A severely blurred/cropped capture should ask for a retake before spending quota. One rescue result is validated against the local result; FinSight does not cascade through multiple paid providers.

Define a provider-neutral adapter that returns the versioned FinSight field/item/evidence schema plus unit accounting. Expand the current hard-coded `gemini | veryfi` and `ocr | vision` types to explicit provider and extraction-source enums without exposing them as client-controlled choices. For Azure F0, create a deterministic provider-bound page derivative under 4 MB, strip EXIF/GPS, record resize/compression/source dimensions, and map returned regions back to the reviewed image. Its two-page request ceiling does not change FinSight's eight-page receipt model; submit only the pages selected by the rescue gate and count Azure page units.

### 5.2 Cost controls

1. Require a finite monthly provider limit whenever any paid-capable provider is enabled. An unset limit must mean zero calls, not unlimited calls.
2. Define each provider's `unitType`, such as page, image feature, or document transaction. Reserve billable units atomically in PostgreSQL before dispatch, then finalize used units or retain an ambiguous reservation according to a documented retry policy. An ambiguous reservation continues to count against the cycle cap until provider usage or billing evidence resolves it; no timeout releases it automatically.
3. Cache successful normalized results by ordered input hashes, preprocessing/schema/provider/model versions, language/options, and active business. This prevents known repeat dispatches; it cannot promise that a provider did not bill an accepted request whose response was lost.
4. Permit at most one automatic analysis submission per immutable provider input/version. Do not automatically repeat a timed-out call with unknown billing outcome; an owner-approved retry reserves new units.
5. Record provider, unit type, reserved/final billable units, page/document counts, estimated micro-cost, latency, outcome, and rescue reason without logging receipt text.
6. Alert at 75%, 90%, and 100% of the configured budget. At 100%, open manual review rather than trying another paid provider.
7. Recheck pricing quarterly and before any provider/model version change.
8. If Veryfi is used in a benchmark, reserve one document-transaction unit for every actual API submission, send an idempotency key, set `auto_delete: true`, and verify training opt-out. Replace the current non-atomic per-scan counter because it can undercount the existing per-page API submissions.

### 5.3 Supabase cost posture

The current Supabase Free plan lists 500 MB database storage, 1 GB file storage, 5 GB egress plus 5 GB cached egress, and 50,000 monthly active users. An organization may have two active free projects, but billing scope differs by quota, so the target project's and organization's usage must both be measured. Free projects can pause after a week of inactivity, and Supabase currently lists leaked-password protection as unavailable on Free. Pro starts at USD 25/month with larger included quotas, backups, and leaked-password protection that the current project requires before a real password-based owner account is treated as production-ready.

FinSight should stay on Free only for the synthetic capstone if measured storage fits. Track `average stored MB per receipt page × retained pages` rather than assuming 1 GB is enough. For a real owner using password authentication, the lowest-risk recommendation is the existing Supabase stack on Pro rather than replacing Auth and backup operations merely to preserve a zero-dollar hosting line. An approved equivalent control can be evaluated, but OCR itself does not require the upgrade.

For any Pro organization, enable its Spend Cap and verify that setting in the target organization at release. The cap covers only named usage items; it does not cover compute or explicitly provisioned add-ons. Inventory every excluded item, keep the included compute class, and prohibit any paid add-on without explicit owner approval. Monitor the upcoming invoice even with the cap enabled. This is the enforceable interpretation of FinSight's no-paid-overage decision; the base Pro subscription remains the approved low-cost exception for real-owner security and backup controls.

## 6. Database and API changes

Migrations must be staged and backward-compatible while old and new clients overlap. Some changes, such as making legacy tenant ownership non-null and later retiring compatibility routes, are intentionally not additive. Database work precedes service and client work. Every root tenant table must include and index `businessProfileId`; dependent tables derive ownership through a non-null parent unless they need an independent profile query. If a child duplicates `businessProfileId`, enforce a composite parent relation such as `(parentId, businessProfileId)`, not merely two unrelated foreign keys. Enable RLS, define no direct client policy, and revoke `anon` and `authenticated`, including default privileges.

### 6.1 MVP schema changes

| Model | Change | Purpose |
| --- | --- | --- |
| `ReceiptScan` | Add nullable typed `invoiceNumber`, local transaction time plus optional known offset, `currencyCode`, `subtotal`, `taxTotal`, `discountTotal`, `paymentMethod`, `handwrittenNotes`, `handwritingSuspected`, `currentStage`, `scanRevision`, and source-deletion fields | Durable requested fields, honest stage UI, optimistic edit guards, and detachable image evidence |
| `ReceiptScan` | Backfill/resolve legacy rows, then make `businessProfileId` non-null; add indexed profile-scoped semantic and perceptual fingerprints | Remove nullable tenancy and arbitrate duplicate confirmations from different scans |
| `ReceiptScan` | Upgrade versioned `fieldEvidence` JSON to hold field key, page/segment, normalized polygon, source dimensions, local/provider source, confidence band, and extractor version | One provider-neutral field-to-region contract without an immediate high-volume evidence table |
| `ReceiptScanPage` | Add source dimensions, transform version, safe normalized external result/cache key, and provider-input hash/version | Map regions, avoid known repeat dispatches, and preserve provider-independent evidence |
| `ReceiptScanItem` | Add category source, rule/model version, category confidence band, and original name/quantity/unit-price/amount evidence | Explain category decisions and preserve OCR values when an owner edits an item |
| `ReceiptFieldCorrection` | Widen the allowed field vocabulary and store normalized original/final values where comparisons need it | Evaluate every requested field; keep display text for audit |
| `ReceiptCaptureBatch` | Profile, client batch key, status, created/finished timestamps; `ReceiptScan` adds batch ID and receipt ordinal | One durable batch containing several separate scans without merging their totals |
| `ExternalProcessingConsent` | `businessProfileId`, provider, policy version, allowed data classes, granted/revoked timestamps, actor | Verifiable third-party OCR consent per business |
| `ExternalProviderBudget` | Provider, UTC cycle bounds, optional profile scope, unit type, limit, reserved units, used units, updated timestamp | Atomically enforced resource-wide and optional per-profile aggregates with conditional reservation |
| `ExternalProviderDispatch` | Budget/profile/scan/page, unit type, reserved and final billable units, page/document counts, request/input/version key, estimated cost, final/ambiguous status | Immutable dispatch ledger and conservative timeout accounting |
| `ReceiptDuplicateCandidate` | Profile, source scan, candidate scan/expense, detector version, reason codes, score band, review status, decided-by/at | Multiple reviewable matches; semantic fingerprints remain non-unique because Save anyway is allowed |
| `CategoryRule` | `businessProfileId`, rule type, normalized pattern, optional vendor pattern, category ID, priority, exclusions, enabled, owner-approved flag, version | Explainable profile-specific categorization |
| `ImportRowResult` | Batch ID, source row, lifecycle status, normalized record type, version, findings/error details, duplicate reference, created record ID, and reprocess parent | Complete result views, reports, and failed-only retry; ownership derives through the batch |
| `ImportMappingTemplate` | Profile, owner name, normalized header signature, mapping/date/currency settings, last-used timestamp | Reusable mappings without cross-business leakage |
| `CSVImportBatch` | Add file type, detected encoding, parser version, available/selected worksheet, row-result readiness, parent batch, and actor | Conditional `.xlsx`, provenance, deterministic worksheet choice, and rejected-row reprocess |
| `SecurityAuditEvent` | Profile, action, actor kind/ID, entity type/ID, result, safe metadata, timestamp/expiry | Security/audit trail with no receipt text or file URL and a defined retention period |
| `ReceiptPurgeJob` | Profile/scan, artifact manifest, stage, attempts, last error, heartbeat, requested/completed timestamps | Resumable owner deletion and abandoned-scan cleanup while paths still exist |

Use database constraints for currency-code length, confidence range, nonnegative billable units/costs, valid lifecycle statuses, and unique `(batchId, sourceRow, version)`. Enforce one resource-wide budget with a partial unique index on `(provider, cycleStart, unitType)` where `businessProfileId IS NULL`, and one profile budget with a unique key on `(provider, cycleStart, unitType, businessProfileId)` where it is non-null. When both limits apply, reserve the resource row first and the profile row second in one transaction, using the same canonical lock order everywhere. Index import pagination through the batch by `(batchId, lifecycleStatus, sourceRow)`, pending work by status/next-attempt, category lookup by `(businessProfileId, enabled, ruleType)`, and duplicate lookup by `(businessProfileId, semanticFingerprint)`. Lock or transactionally recheck the semantic fingerprint during confirmation. Enforce same-profile category and duplicate references with composite keys where a direct profile key is duplicated.

Do not create a normalized field-evidence table in MVP unless bounding JSON becomes unmanageable. The current versioned `fieldEvidence` JSON is a smaller migration. A Post-MVP table is justified only when query plans or analytics require individual evidence rows.

Deprecate `VeryfiUsage` only after reconciling its final counter into the new budget/dispatch records. Do not enforce quota from two sources. Detailed processing-stage events, normalized long-scan segment rows, and long-term category-decision history remain Post-MVP; MVP stores current category provenance on items and confirmed outcomes in correction rows.

Post-MVP guarded import undo adds `undoEligibleUntil`, `undoneAt`, and the relational checks needed to prove that each affected record is unchanged and unreferenced. Do not add dormant undo fields to the MVP migration.

### 6.2 Receipt APIs

The paths below are under the current `/api/v1` prefix. Keep current routes and extend their contracts:

| Method and route | Change |
| --- | --- |
| `POST /records/receipt-batches` | Create an idempotent profile-scoped batch for several explicitly separated receipts |
| `GET /records/receipt-batches/:batchId` | Return each child scan's ordinal and current result/recovery state |
| `POST /records/receipts` | Keep multipart pages, optional originals, metadata, idempotency, optional batch ID/ordinal; stream/store sequentially, enqueue only, and return `202` with scan/poll IDs |
| `GET /records/receipts?status=&cursor=` | Cursor-paginated scan history and resumable review queue for the active business |
| `GET /records/receipts/:id` | Return current stage, completed page evidence, structured fields, duplicate summary, category reasons, and recovery actions |
| `POST /records/receipts/:id/retry` | Requeue the complete unconfirmed scan from stored bytes, apply sustained limits/budget, and do not auto-repeat an ambiguous cloud dispatch |
| `GET /records/receipts/:id/pages/:page/image/:variant` | Return a ten-minute signed URL after profile ownership validation; variants are source, rectified, or enhanced |
| `PATCH /records/receipts/:id/items/:itemId` | Correct item values only when processing is Complete and confirmation is Pending; require expected `scanRevision` |
| `POST /records/receipts/:id/confirm` | Keep the atomic Pending-to-Confirmed claim and correction capture; add corrected fields/items plus distinct-scan fingerprint lock/recheck |
| `GET /records/receipts/:id/duplicate-candidates?cursor=` | Paginate candidate reasons and safe summaries, never another business's record |
| `DELETE /records/receipts/:id` | Tombstone an unconfirmed scan and queue resumable private-artifact cleanup |
| `DELETE /records/receipts/:id/images` | Detach/delete image and OCR artifacts from a confirmed receipt while retaining the financial record and minimized audit evidence |
| `GET/PUT/DELETE /records/external-processing-consents/:provider` | Read, grant/update, or revoke the active business's versioned provider consent |

The client never selects a provider. It requests retry or consent; the server applies policy, quota, and routing.

Split receipt enqueue/query commands from OCR processor modules so the API process cannot import the provider execution path accidentally. Integration tests create a scan, then drive `runReceiptWorkerOnce()` explicitly. Run one dedicated receipt-worker replica at concurrency one for MVP; keep CSV/analysis/deletion work on separate processes or enforce fair per-queue work limits so a large workbook cannot starve receipt deletion.

Post-MVP page retake uses a new upload plus expected scan revision, increments the revision, and reruns receipt-wide merge, reconciliation, categorization, and duplicate detection. It cannot invalidate only page-local results safely.

### 6.3 Import APIs

| Method and route | Purpose |
| --- | --- |
| `POST /records/imports` | Upload once, validate content, create a durable batch, store privately, and return `202` |
| `GET /records/imports/:id` | Batch state, parser progress, counts, warnings, and allowed actions |
| `GET /records/imports/:id/preview` | Available worksheet names, selected worksheet, headers, sample rows, detected settings, and mapping confidence after asynchronous preparation |
| `PATCH /records/imports/:id/mapping` | Store selected worksheet, mapping/date/currency choices, and optionally save a profile-scoped template |
| `POST /records/imports/:id/validate` | Queue a full validation pass; idempotent by mapping version |
| `GET /records/imports/:id/rows?status=&finding=&cursor=` | Cursor-paginated lifecycle rows, filterable by warning, duplicate, or validation finding |
| `PATCH /records/imports/:id/rows/:sourceRow` | Store an owner correction with expected row/batch version; reject stale edits after remap/revalidation |
| `POST /records/imports/:id/corrections` | Optionally upload a correction file containing batch ID, source row, corrected fields, and expected version for large repairs |
| `POST /records/imports/:id/confirm` | Import selected eligible rows from persisted normalized values; no second source-file upload |
| `GET /records/imports/:id/error-report.csv` | Stream a sanitized, complete error report |
| `POST /records/imports/:id/reprocess` | With expected batch version and corrected row IDs, create a child attempt for rejected rows only; imported record IDs stay excluded |
| `POST /records/imports/:id/undo` | **Post-MVP:** guarded compensating delete for unchanged records created by this batch, followed by one profile-analysis refresh |
| `GET/POST /records/import-mappings` | List or create profile-scoped mapping templates |
| `PATCH/DELETE /records/import-mappings/:templateId` | Update or delete one owner/profile-validated template |

For compatibility, keep current `/records/csv-imports` endpoints during one client release and translate them into the new batch workflow. Remove them only after web/mobile contract tests prove migration.

### 6.4 Error contract

Use machine-readable codes with owner-safe messages and actions. Examples:

- `RECEIPT_IMAGE_TOO_DARK`: “This photo is too dark to read reliably.” Actions: Retake, Adjust crop, Use anyway.
- `OCR_BUDGET_REACHED`: “Cloud re-reading is unavailable this month. You can still enter or confirm the details.”
- `IMPORT_UNSUPPORTED_WORKBOOK`: “Use an .xlsx workbook without macros or export it as CSV.”
- `IMPORT_ENCODING_UNKNOWN`: “Choose the file encoding or export as UTF-8 CSV.”
- `IMPORT_PARTIAL_SUCCESS`: build “{importedCount} rows were imported. {rejectedCount} need correction.” from persisted counters.

Do not return provider names, raw stack traces, bucket paths, internal model prompts, or secrets in error text.

Persist a stable public error code plus owner-safe message. Keep sanitized diagnostic detail server-side. Replace the tracked raw Veryfi spike payload with derived metrics after confirming its provenance, and invalidate any provider asset URL that remains live.

## 7. Web and mobile UI/UX improvements

The interaction mode is Operate: speed, evidence, recovery, and native behavior take priority over visual novelty. Reuse FinSight's financial-trail progress treatment and semantic status roles.

### 7.1 Mobile capture

Keep the existing Standard and Long modes. Add or verify these states on the physical implementation:

- live guidance chooses one instruction at a time: “Move closer,” “Hold steady,” “More light needed,” “Keep all four edges visible,” or “Move down slowly”;
- the boundary highlight is green only when all four edges are present and the configured stability, blur, exposure, and minimum-document-size gates pass;
- automatic capture has a visible/haptic countdown or stable-state signal and remains cancellable;
- glare and shadow warnings point to a region when detection supports it; until a glare metric exists, do not claim glare detection or removal;
- Long mode shows the real accepted composite thumbnail, overlap state, and “Bottom found,” never a fake completion percentage;
- every failure preserves gallery and manual-section recovery;
- backgrounding stops the camera/torch, an unfinished long scan gets a discard decision, and an approved image survives returning from review;
- controls meet 48dp Android and 44pt iOS targets, scale with text, respect safe areas, and work with TalkBack/VoiceOver and reduced motion.

For Standard native capture, take a full-resolution still after stable analysis and map the detected corners onto it. Retain that source privately, then create rectified and enhanced variants. For MVP Long capture, retain the bounded unenhanced composite as the source evidence and label it Composite source, not original. If that representation fails the long-receipt benchmark, direct the owner to ordered multi-page manual capture. Retained source segments and segment-specific review remain Post-MVP.

Route every camera handoff through the same quality contract. The selected-image strip must show blur, darkness, and too-small results, not only blur. In manual mode, run edge suggestion automatically after capture, apply the existing measured confidence threshold, and let the owner approve corners before transformation.

Do not put provider branding in the camera. FinSight may study task patterns from commercial scanners, but must use its own layout, copy, assets, and interaction details.

### 7.2 Processing and review

Use one vertical trail rather than a grid of status cards:

```text
Uploaded 3 pages
Checking image quality
Reading page 2 of 3
Validating totals
Checking duplicates
Ready to review
```

- Announce stage changes to screen readers without moving focus.
- Let the owner leave the screen after upload; show the durable job in the review queue and resume polling when they return.
- Show one primary recovery action for the current failure, with secondary “Enter manually” and “Delete scan” actions.
- Put the image and current field in the same context. Web uses a split view with a selectable page strip and synchronized highlight; mobile replaces the cropped 96 by 128 thumbnails with a selectable strip plus a full-screen, pan/zoom, `contain` viewer.
- Mark fields as “Check this,” “Read from receipt,” or “Calculated,” not only with color or unexplained percentages.
- Show Source by default when a full-resolution source still exists, with explicit Rectified and Enhanced toggles. A continuous unenhanced composite is labeled Composite source, never “original.”
- Present duplicate candidates before save with vendor, date, total, and reason. “Save anyway” requires an explicit choice but is allowed.
- Preserve edits across network errors and retries.
- Make item name and amount editable first, record both values, and recalculate reconciliation in integer currency minor units. Add quantity/unit-price edits only with a clear rule for derived line totals.
- Add a named close button and proper dialog semantics to web image zoom. Clicking the image must not dismiss it.
- Separate actions precisely: “Retry processing” reuses stored bytes, “Review result” opens the cached result, and “Choose another image” invalidates the local selection. Add “Cancel upload” or “Stop waiting” on web to match mobile.
- Bound background batch prefetch instead of starting every remaining receipt concurrently; show each receipt's state.

### 7.3 Import experience

Use a four-step flow on both clients: File, Map, Review, Result.

1. **File:** accepted formats and limits, private-processing note, upload progress, and a sample template download.
2. **Map:** worksheet selector when applicable, detected headers, record type, date convention, currency, required-column status, and optional “Save mapping for this format.”
3. **Review:** tabs for Valid, Warning, Duplicate, and Rejected use a deterministic priority so one row appears once: Rejected, else Duplicate, else Warning, else Valid. The underlying row still keeps all findings. Mobile uses paginated lists, not a squeezed table.
4. **Result:** imported/skipped/duplicate/warning/failed counts, complete error-report download, and a reprocess-rejected action. Add guarded undo only with the Post-MVP eligibility contract.

Warnings and duplicates should default to review, not silent import or silent rejection. The confirmation action names the policy and inserts the persisted count, such as “Import {validCount} valid rows,” rather than “Continue.”

Add a visible mobile “Separate receipts” choice that assigns a distinct `receiptGroupId` at each boundary and uses the durable batch contract. Dormant grouping scaffolding is not product support. Web's existing separate-receipt mode must adopt the same batch IDs and pass a multi-page/batch journey test before either client calls the feature complete.

### 7.4 Categorization UI

- Show the chosen category and a short source: Owner rule, Past choice, Keyword rule, or Suggested.
- High-confidence decisions are selected in the draft but remain editable before receipt confirmation.
- Medium confidence is selected with “Please confirm.”
- Low confidence remains Uncategorized and displays up to three ranked existing categories.
- After a correction, offer “Always use this category for this vendor” as an unchecked owner action. Do not create a rule silently.
- Provide a business-scoped rule-management screen with order, match conditions, category, enabled state, and recent match count.

## 8. Accuracy and confidence-scoring strategy

### 8.1 Separate scores by decision

Do not average unrelated signals into one reassuring number. Maintain:

- image quality signals: sharpness, exposure, glare, clipping, document coverage, and completeness;
- OCR token/line confidence by page and image candidate;
- field extraction probability calibrated per provider, field, language, and receipt cohort;
- validation state: arithmetic, date, currency, vendor, and cross-provider agreement;
- reconstruction state: segment order, overlap strength, duplicated lines, and missing-edge evidence;
- category probability calibrated per business and decision source;
- duplicate-candidate score calibrated independently from category/extraction confidence.

Provider confidence is never compared raw across providers. Fit calibration from confirmed corrections, or use conservative rule bands until enough labels exist.

### 8.2 MVP review bands

| Band | Rule | Behavior |
| --- | --- | --- |
| High | Field passes its calibrated threshold and all applicable validation; no provider conflict or damage/handwriting flag | Pre-fill and mark “Read from receipt.” Receipt still requires owner confirmation. |
| Medium | Field is present but has one weak signal, disagreement, ambiguous date/currency, or uncalibrated provider score | Pre-fill, highlight, and request confirmation. |
| Low | Missing, conflicting, failed validation, suspected handwriting/damage, or below the calibrated threshold | Leave blank when safer, show evidence and ranked candidates, and focus it in review. |

Critical-field overrides:

- Apply a layout-aware reconciliation policy. Add only tax/service charges explicitly excluded from subtotal; treat tax-inclusive VAT as supporting evidence, not another amount to add. A mismatch within the currency's documented rounding rule forces affected fields to Medium or Low.
- A future date, impossible calendar date, or ambiguous day/month format forces review.
- Currency comes from a printed symbol/code plus business locale/context; context alone cannot create High confidence.
- MVP stores source currency as evidence but keeps the existing PHP bookkeeping rule. A non-PHP receipt cannot confirm until the owner supplies a PHP-converted amount and records the conversion basis manually. Full exchange-rate accounting would change the financial model and is Post-MVP.
- Vendor normalization may match aliases, but the raw printed value remains visible.
- Payment method stores a normalized type such as cash, card, bank transfer, or e-wallet. Do not retain full account/card data, and retain last-four evidence only if a documented business need and redaction policy are approved.
- A cloud value replaces a local value only when the normalized candidate and validation evidence are better. Provider name or raw confidence alone is insufficient.

### 8.3 Category confidence

Use source-specific evidence rather than one arbitrary weighted formula:

- High: an active rule deliberately created or approved by the owner. A rule suggestion may come from history, but the learned/history source itself remains Medium or Low until the Post-MVP promotion gate; only the resulting explicit owner instruction is High in MVP.
- Medium: exact or consistent profile-specific history/token candidates with a clear winner.
- Low: tied candidates, model-only output, unseen vendor/item, or category set changed since training.

Automatic category assignment is a draft convenience. It never bypasses receipt confirmation. For imported transactions, High may import as assigned only when the owner selected “accept high-confidence categories”; otherwise all suggestions remain reviewable.

## 9. Testing and evaluation plan

### 9.1 Corpus governance

Create a private, encrypted corpus manifest with consent ID, source, capture device, language, receipt type, condition tags, page/segment relationships, redaction state, ground-truth version, and permitted uses. Keep images out of Git. Store de-identified ground truth separately from provider credentials.

Required cohorts overlap where appropriate:

- clean printed thermal and plain-paper receipts;
- faded, crumpled, tilted, shadowed, glared, low-light, blurred, and partially damaged receipts;
- long receipts with repeated equal-price lines and deliberate overlap variation;
- handwritten receipts and handwritten notes;
- English, Filipino, mixed-language, and numeric-heavy layouts;
- multi-page documents and several independent receipts captured in one session;
- non-receipt documents and near-duplicate/rephotographed receipts.

Use one capstone tier plus decision-specific promotion sets:

- **Capstone demonstration set:** at least 30 unique consented real receipts, including at least 5 examples tagged in each of clean printed, stressed/faded, long, handwritten, Filipino/mixed-language, and damaged/low-light cohorts. Tags may overlap. Add at least 10 non-receipts plus 10 known duplicate and 20 known non-duplicate pairs. No vendor template exceeds 20% of receipts. This set supports transparent point estimates and workflow demonstrations, not a production accuracy claim.
- **Provider OCR promotion set:** at least 100 unique real receipts with at least 30 in every receipt cohort affected by that provider decision.
- **Post-MVP learned category promotion set:** at least 300 confirmed category decisions within the same business profile being evaluated. Decisions from another profile cannot contribute; precision support and the interval are computed for that profile. Receipt samples and duplicate-pair counts do not fill this requirement.
- **Duplicate-detector promotion set:** at least 100 known duplicate pairs and 200 known non-duplicate pairs. OCR receipt counts and category decisions do not fill this requirement.

Phase 0 freezes these as decision-specific minimum floors in policy v1. Any change requires a versioned policy update before the first eligible result for that decision is opened; a later result can never be used to lower its floor. A cohort or source below its applicable floor stays `UNCALIBRATED`. Learned/history/model category promotion remains Post-MVP even when its support floor exists.

A unique receipt is one distinct eligible `receipt_id` with exactly one predeclared primary row. Additional pages, long segments, processed variants, and recaptures keep that receipt ID and never add another receipt, vendor-template, or cohort count. Cohort membership comes only from the sealed `cohort_tags` values and predicates in the Phase 0 corpus data dictionary. Recaptures can enter only a predeclared robustness analysis and cannot replace a primary attempt after its result is seen.

Synthetic samples remain a separate regression set and never fill a real-receipt minimum.

The import fixture matrix covers 1, 2,000, 2,001, 30,000, and 30,001 rows; UTF-8, UTF-8 BOM, UTF-16 LE BOM, and UTF-16 BE BOM CSV; Unicode Filipino/vendor text; comma/semicolon/tab delimiters; duplicate/empty headers; 1900 and 1904 Excel date systems; exact decimal edge values; multiple sheets; and every rejection class. For MVP, configure and test a 5 MiB (5,242,880-byte) uploaded file-body cap, excluding multipart envelope bytes; a 50 MiB (52,428,800-byte) decompressed OOXML aggregate cap; a 200 archive-entry cap; a 30,000-row cap; and one explicitly selected worksheet. Formula cells, macros, embedded objects, external links, encryption, excessive compression, and malformed XML each have a named rejected fixture.

Declare the physical Android matrix before scanner tuning: at least one device near FinSight's minimum supported API/RAM class and one mainstream target. Record model, OS/API level, camera output, RAM and app memory class, build type, and thermal starting state. Phase 0 freezes the maximum session duration, repeated-session count, and numeric peak-PSS ceiling for each target before results are examined.

### 9.2 Metrics

| Metric | Definition |
| --- | --- |
| Character error rate | `(substitutions + insertions + deletions) / ground-truth characters` on normalized text |
| Word error rate | Same edit-distance definition over words |
| Field exact match | Exact normalized value, reported separately for vendor, invoice number, date, time, subtotal, tax, discount, total, payment, and item fields |
| Total accuracy | Exact currency-minor-unit match; also report absolute error when wrong |
| Line-item accuracy | Item precision/recall plus quantity, unit-price, and line-total exact match |
| Reconstruction accuracy | Ground-truth line recall, order accuracy, duplicated-line rate, and missing-line rate |
| Category quality | Precision for automatic assignments, top-3 recall for suggestions, coverage, and correction rate |
| Duplicate quality | Precision and recall over labeled original/duplicate pairs |
| Confidence calibration | Reliability by confidence decile, Brier score or expected calibration error, and correction rate per band |
| Processing time | p50/p95 end-to-end and by stage, split by page count, provider, cold/warm run, and declared hardware |
| Manual correction rate | Confirmed fields/items changed divided by reviewed fields/items, by cohort and extractor version |

### 9.3 Frozen v1 targets and release gates

These are frozen product targets, not current results. The machine-readable source is [Phase 0 benchmark policy v1](phase-0/benchmark-policy-v1.json). The capstone blocks on safety/workflow behavior and the applicable point-estimate targets from its smaller set, but passing those targets is not a production accuracy claim. Enabling a learned/model-derived automatic decision or making a production claim also requires the promotion support above and a reported 95% confidence interval. An explicit owner-authored category rule is an instruction and does not require model-promotion statistics.

| Area | Frozen v1 gate on the eligible real-receipt set |
| --- | --- |
| Clean printed critical fields | Total and currency-code exact match each at least 95%; normalized vendor and date each at least 90%; no incorrect currency receives High confidence. |
| Stressed printed critical fields | Total exact match at least 85%; every missing/conflicting critical value and every uncertain currency is visibly routed to review; no incorrect currency receives High confidence. |
| Handwriting | Report CER, WER, and field exact match; no handwritten financial field receives a High band or is omitted from focused review in MVP |
| Long receipt | At least 95% line recall, at most 1% duplicated lines, correct order for at least 95% of lines, and no known-truncated scan labeled complete |
| Categorization | MVP High is limited to active owner-authored rules. Any Post-MVP learned/history/model High-band automatic assignment needs a 95% confidence-interval lower bound of at least 95%, the promotion support floor, and a separate decision; lower learned coverage is preferred to lower precision. |
| Duplicate detection | Precision at least 98% and recall at least 90%; all matches stay owner-reviewable |
| Confidence bands | Error rate is monotonic from High to Medium to Low for each critical field; any band with fewer than 30 reviewed predictions for that field/provider/cohort remains `UNCALIBRATED` |
| Performance | On declared targets: live capture guidance p95 at most 500 ms; one-page local result p95 at most 15 seconds; worker heartbeat at most 30 seconds; a stale scan is reclaimed or failed within 130 seconds |
| Large import performance | On the declared deployment worker across at least 20 cold/warm trials, a ClamAV-scanned 30,000-row CSV reaches its durable validation result within 10 minutes at p95, import-worker peak RSS stays at or below 512 MiB, and ClamAV plus all services retain at least 30% measured host-memory headroom; an enabled `.xlsx` path meets the same ceilings |
| Safety | No cross-profile result, image, rule, mapping, duplicate candidate, or signed URL in adversarial ownership tests |

Always report numerator, denominator, point estimate, and interval. Policy v1 maps each metric family to exactly one method. Binary sample, field, category-decision, and pair proportions use a two-sided 95% Wilson score interval without continuity correction. Clustered line/item/text, correction, calibration, continuous-error, latency, and memory metrics use a two-sided percentile bootstrap with 10,000 resamples, seed `20260913`, and the distinct receipt or declared independent trial specified in the policy as the resampling unit. The explicit policy map wins, and any unlisted metric requires a versioned method before an eligible result. Provider differences use paired receipt-level bootstrap resampling, and every affected cohort must meet its applicable point gates independently; a macro average cannot hide a failed affected cohort. Only Post-MVP learned-category High uses the interval's lower endpoint as a promotion threshold. OCR-provider and duplicate choices use their frozen point gates plus the reported interval and safety/review controls; neither supports a production accuracy claim. Handwriting success for MVP is a safe assisted workflow, not a promised recognition rate.

### 9.4 Fair provider benchmark

1. Freeze one labeled corpus and normalized field schema before provider runs.
2. Use the exact same source bytes unless a provider's documented limit requires a recorded transform.
3. Stage the benchmark. First compare the current local Tesseract path with Azure F0. If Azure fails a gate or policy constraint, test one next candidate at a time, starting with free PaddleOCR or low-cost Google Vision. AWS, Veryfi, Google Document AI, and TrOCR remain desk-reviewed until a recorded failure hypothesis justifies implementation and any paid units are approved.
4. Pin provider region, API/model version, language hints, parameters, and date.
5. Run cold and warm latency trials and record failures, retries, rate limits, billable-unit accounting, and provider invoice/usage reconciliation where available. Keep failed, timed-out, and missing applicable results in the denominator as incorrect, and report failure/timeout rates separately.
6. Score raw OCR and normalized fields separately. A good parser must not hide poor text recall, and good OCR must not be mistaken for structured extraction.
7. Report each cohort separately and a macro average. Do not let many easy receipts conceal handwriting or long-receipt failures.
8. Select first by critical-field safety gate, then privacy/legal fit, then monthly cost, latency, and implementation effort. Do not select by vendor confidence score.

### 9.5 Automated and human tests

- unit: normalization, arithmetic, date/currency ambiguity, confidence bands, rule precedence, quota reservations, archive limits, and export formula neutralization;
- contract: normalized provider schemas, backward-compatible clients, error codes, and signed-URL ownership;
- integration: worker crashes, stale leases, duplicate idempotency keys, provider timeout, budget exhaustion, row reprocess, and account deletion; add undo-conflict coverage with the Post-MVP feature;
- mobile: camera state machine and accessibility automation, then the physical-device matrix for permissions, backgrounding, process recreation, low memory, thermal behavior, torch, TalkBack, and long capture;
- web: keyboard-only review, zoom/evidence synchronization, screen-reader announcements, import pagination, report download, and Firefox/WebKit coverage;
- security: malicious multipart boundaries, MIME spoofing, ZIP bombs, workbook external links/macros, CSV formula injection, tenant ID tampering, expired signed URLs, and log redaction;
- operations: backup/restore, Storage deletion, queue recovery, quota reset, and provider kill-switch drills.

## 10. Security and privacy requirements

### 10.1 Upload and file handling

- Authenticate and apply durable rate limits before multipart parsing.
- Make the dedicated receipt worker the only OCR/provider consumer. Upload and retry enqueue; they do not call the processing function in the API process.
- Replace the current up-to-16-file in-memory receipt request with bounded temporary-file or streaming ingestion and sequential private upload. Enforce 10 MiB per object, eight logical pages, and 80 MiB total at client/API/tests; set the proxy only high enough for measured multipart overhead.
- Validate extension, declared MIME type, byte signature, decoded dimensions, page count, decompressed size, compression ratio, and parser limits.
- Keep existing receipt formats JPEG, PNG, and WEBP. Strip EXIF and GPS from derived/provider-bound images while preserving the private original according to policy.
- Accept CSV and, only after its release gate passes, `.xlsx`. Reject `.xls`, `.xlsm`, executables, encrypted/password-protected workbooks, external-link-dependent cells, and archives with unexpected entries.
- Before `read-excel-file`, inspect the OOXML ZIP central directory and relationship/XML parts with decompressed-byte, entry-count, nesting, and compression-ratio limits. Reject macro parts, embedded objects, external relationships, and every formula element in MVP.
- Override `read-excel-file` number parsing so authoritative money begins as an exact decimal string/type and is converted with `Prisma.Decimal` or integer minor units. Never route financial cells through JavaScript `Number`; reject empty/uncomputed formula values rather than treating them as zero.
- Scan every import upload with ClamAV before parsing. Keep `clamd` on an internal Unix socket or authenticated private network; its TCP interface has no built-in authentication.
- Store uploads under server-generated profile-prefixed paths. Never trust a filename as a Storage path.
- Formula-neutralize any downloadable CSV error report so owner-controlled cells cannot execute when opened in a spreadsheet. Preserve numeric amounts as typed numeric output; neutralize untrusted text beginning with spreadsheet formula markers.

### 10.2 Encryption and key handling

- Require TLS 1.2 or newer for client/API, API/Supabase, and worker/provider traffic; verify certificates, redirect HTTP, and enable HSTS at the production edge.
- Require encrypted PostgreSQL connections and verify database, private Storage, and any enabled backup encryption at rest in the target environment. Document who can access provider-managed keys and rotate application/provider secrets independently.
- Restrict temporary upload permissions to the API/worker account, never place them in a public web root, and securely delete them after sequential Storage upload or failure.
- Keep mobile capture files in application-private, backup-excluded cache and purge them on confirm, discard, logout, account deletion, or after 24 hours. Any future process-death draft persistence encrypts files with an OS-keystore-backed key.
- Encrypt the private evaluation corpus and ground-truth backups at rest, restrict access to named corpus custodians, and record access/deletion events without copying receipt contents into the audit log.
- Test encrypted backup restore and key/secret rotation. A TLS configuration check or provider marketing statement alone is not sufficient evidence.

### 10.3 Secrets and third-party processing

- Keep provider keys in server/worker secrets only, separate per environment, least-privileged, and rotatable.
- Before the first cloud rescue for a business, explain provider category, data sent, purpose, retention link, configured processing region, and how to revoke consent.
- Send only the minimum page/crop needed. Never send unrelated profile data, category history, or another receipt as context.
- Use provider settings/contracts that prohibit training on customer content where available. Do not send real financial receipts through the Gemini developer free tier. Real-data use requires paid-tier data terms, explicit consent, schema validation, and an approved benchmark.
- Record consent version and dispatch metadata, but do not put OCR text, full vendor details, card fragments, or image URLs in application logs.
- Map provider failures to stable public codes. Never persist or return raw exception/provider response text as `processingError`.
- A provider kill switch must immediately route all work to local OCR/manual review.

### 10.4 Tenant isolation and authorization

- Resolve the authenticated user, then the active business profile, on every service call. Never authorize from a client-supplied profile ID alone.
- Scope reads, writes, retries, downloads, rules, mapping templates, row results, duplicate candidates, and audit events by the active profile.
- Keep application-table RLS enabled and deny direct `anon`/`authenticated` table access. New migrations must repeat explicit revokes and default-privilege protection.
- Do not rely on Supabase's announced October 2026 change that stops automatically exposing new `public` tables through the Data API. Explicit RLS and privilege revokes remain FinSight's controlled, testable posture.
- Keep receipt/import buckets private. Generate receipt read URLs only after ownership validation and keep the current ten-minute expiry.
- The one human owner may capture, review, import, and delete data for the active business. Post-MVP undo remains owner-only under the same active-business check. Do not add invitations, collaboration, delegated approval, staff, bookkeeper, or administrator permissions.

### 10.5 Retention, deletion, and audit

MVP:

- delete server temporary uploads immediately after verified private Storage upload or request failure, with an hourly sweep as a backstop;
- delete abandoned Pending/Failed scan images, raw OCR, and derived artifacts 7 days after last activity unless the owner resumes or deletes sooner;
- retain confirmed receipt evidence until the owner deletes/detaches its images or deletes the financial record; detaching an image must not delete the confirmed amount/category history;
- delete completed/failed import source files and rejected-row repair values after 30 days unless a reprocess is active; keep minimized aggregate/count provenance with the batch;
- delete provider-side input/result immediately after FinSight ingests and validates the normalized result when an explicit API exists; Azure's documented automatic maximum is 24 hours, and Veryfi benchmarks require `auto_delete`;
- keep the existing account-deletion worker that removes Storage objects before relational ownership evidence;
- delete/expire local scanner cache on confirm, discard, logout, and account deletion, with a 24-hour stale-cache sweep;
- retain minimized security audit events for 180 days, with no receipt text, file URL, item/vendor payload, or payment details;
- if backups are enabled, cap backup retention at 30 days and document that deletion completes as old encrypted backups expire.
- run a scheduled, resumable purge job with leases/checkpoints, retryable Storage-before-database cleanup, and an append-only result containing counts and safe identifiers only.

Post-MVP:

- add per-business retention settings for originals, derived images, OCR text, and import source files;
- permit redacted retained evidence when full images are no longer required;
- define any legal/tax retention requirement with qualified jurisdiction-specific advice before changing defaults.

Deleting a scan removes that scan's source, derived, correction, category-provenance, and duplicate-candidate artifacts. Account deletion removes all business-scoped receipt, import, consent, rule, and audit data after Storage cleanup. A separately retained operational deletion receipt, if required, must be anonymous and contain no business content.

## 11. Phased implementation roadmap

Effort ranges assume the existing ownership lanes can work in parallel and include implementation plus focused tests, not receipt collection, device access, privacy approval, or UAT waiting time. After those inputs exist, the estimated parallel critical path is 6 to 9 calendar weeks; a single engineer should plan roughly 10 to 14 weeks. Re-estimate after Phase 0 rather than treating these ranges as commitments.

| Phase | Scope and owner sequence | Exit gate | Estimate |
| --- | --- | --- | --- |
| 0. Baseline and decisions | Orchestrator -> QA + database + DevOps: freeze corpus/schema/benchmark, approve retention/budget/consent, reconcile dirty migrations, and read-only verify hosted schema/grants before layering migrations | Approved repository/migration checkpoint, eligible corpus manifest, exact fixture/threshold policy, two declared Android targets with pre-run PSS ceilings and baseline evidence, and hosted account/data plus security/cost classification | 3 to 5 working days plus receipt collection |
| 1. Worker/upload/cost guardrails | After the Phase 0 checkpoint: database consent/budget work and DevOps language packaging in parallel -> backend worker/upload/dispatch gates -> AI/OCR local rescue decision and disabled provider-neutral seam -> web/mobile contracts plus DevOps proxy/operations -> QA | API never performs OCR; egress-disabled cold OCR passes; paired uploads cannot exceed one enforced aggregate contract; current cloud receipt calls default off; no Azure network adapter is added in this phase | 6 to 9 days |
| 2. Scanner acceptance and results | Database -> backend -> mobile/web/AI-OCR -> QA: full-resolution Standard evidence, physical Android matrix, native timeout/memory fixes, quality parity, whole-scan retry, item edits, inspectable pages, receipt batches | Standard/Long/batch gates pass on declared devices; source/derived evidence and corrections remain accurate | 9 to 14 days plus physical testing |
| 3. Extraction and provider benchmark | Database -> backend contract/integration -> AI/OCR -> affected web/mobile clients -> QA: new fields, normalized adapter, Azure F0 versus Tesseract; test Paddle only if the first comparison records a failure hypothesis | Frozen staged report selects a passing route or leaves cloud off | 8 to 12 days |
| 4A. CSV result completion | Database -> backend -> DevOps + web/mobile -> QA: upload-once import, ClamAV/content checks, row lifecycle/findings, complete report, corrected rejected-row reprocess | Every CSV is scanned before parsing, scanner failure is fail-closed, and a 30,000-row CSV completes with exact counts and recoverable partial failure | 7 to 10 days |
| 4B. Safe Excel extension | Backend -> DevOps + web/mobile -> QA: reuse mandatory malware scanning, add OOXML preflight, decimal-safe `.xlsx`, and the workbook fixture matrix | Every allowed/rejected workbook fixture behaves as section 9 specifies | 5 to 8 days; omit rather than weaken security |
| 5. Categorization | Database -> backend/AI -> web/mobile -> QA: rule engine, item provenance/corrections, confidence bands, rule UI | MVP High comes only from active owner-authored rules and Low never silently assigns; learned/history/model High remains Post-MVP behind its support, precision, and promotion gates | 7 to 10 days plus label accumulation |
| 6. Release gate | QA/security + DevOps + orchestrator: full tests, hosted Supabase audit, backup/restore, capacity, UAT, cost drill | All MVP acceptance criteria below are evidenced; any unavailable physical or human evidence keeps the release gate open and is named | 5 to 8 days plus UAT |

### MVP boundary

- Android Standard and Long scanner hardening and physical acceptance.
- Local Tesseract first pass, expanded structured fields, validation, evidence, honest confidence, and manual correction.
- Optional Azure rescue only after benchmark, consent, and hard free-tier budget.
- Retry without re-upload, stage/result states, field regions, duplicate review, and atomic save.
- CSV upload-once background parsing after mandatory malware scanning, durable row results, complete error report, partial import, and rejected-only reprocess. Add `.xlsx` only when its additional OOXML/precision matrix passes; otherwise keep honest Export as CSV guidance for the capstone freeze.
- Deterministic owner/history/keyword categorization with high/medium/low behavior.
- Tenant isolation, private Storage, deletion, audit, corpus, and cost monitoring gates.

### Post-MVP boundary

- iOS VisionKit scanner and tablet-specific layouts.
- PaddleOCR production candidate, TrOCR handwriting line recognizer, or local embeddings, only after independent benchmark gains.
- Advanced curled-paper dewarping, learned glare segmentation, and cross-device continuous-scanner calibration.
- Normalized field-evidence table, richer processing event timeline, configurable retention, and redaction workflows.
- Provider failover between two paid services. This is justified only by uptime evidence and a budget, not as default complexity.
- Page-specific retake/resume with scan revisions, retained long-scan segments and seam review, direct signed receipt upload sessions, and guarded import undo.

### Change ownership

- **database:** Prisma models, indexes, migrations, RLS/revokes, and query plans;
- **backend-api:** receipt enqueue/query modules, leases/retry state, upload/import endpoints, provider dispatch policy and reservation enforcement, content validation, row results, authorization, safe DTO/errors, storage lifecycle, and the deterministic category rule/history/keyword service;
- **ai-ocr-analytics:** OCR processor internals, provider-neutral adapter implementations, parsing, reconciliation, confidence calibration, `RescueDecision`, optional learned-category scoring, and evaluation reports;
- **mobile:** scanner guidance, lifecycle, progress/review, page recovery, category explanations, and device evidence;
- **web-frontend:** split evidence review, import workflow/results, mapping/rule management, and accessible status behavior;
- **qa-security:** corpus governance, contract/integration/adversarial tests, accuracy reports, and release criteria;
- **devops-release:** production language-data packaging, ClamAV service, secrets, provider budget alerts, worker health, hosted Supabase checks, backups, and runbooks;
- **orchestrator:** dependency order, threshold decisions, evidence review, and final integration gate.

## 12. Risks, tradeoffs, and fallback solutions

| Risk/tradeoff | Control | Fallback |
| --- | --- | --- |
| Tesseract misses handwriting or faint thermal text | Quality guidance, field-level review, Azure rescue benchmark | Manual entry; Paddle/TrOCR research after corpus exists |
| Tesseract creates a fresh worker for every image candidate | Measure page-level CPU/RSS and bound worker concurrency | Post-MVP worker/language-data pool in the dedicated process |
| Tesseract silently reaches a CDN for missing language data | Pin/checksum traineddata in the production image and test a cold run with egress blocked | Fail startup/readiness and keep manual entry available; never claim offline OCR |
| Azure price/free quota or terms change | Provider adapter, quarterly pricing review, finite quota, kill switch | Local OCR/manual review; benchmark AWS or Google Vision |
| Veryfi is easiest because code already exists, but paid economics are poor | Keep disabled with 0 approved units until a separate benchmark approval | Remove production credentials; Azure adapter |
| Continuous stitching deletes or repeats similar lines | Strong overlap constraints, aggregate seam metrics, labeled repeated-line fixtures, and reject-on-gate-failure behavior | MVP ordered multi-page manual capture; Post-MVP retained-segment OCR |
| Image enhancement makes faint text worse | Keep original, compare candidates objectively, require corpus non-regression | Use original as OCR/evidence winner |
| `.xlsx` parsing expands attack surface | Strict format allowlist, archive limits, ClamAV, worker isolation, no macros/formula execution | CSV-only mode with clear export instructions |
| ClamAV memory use does not fit the host | Measure RSS and scan latency before rollout | Use a separate low-cost scan worker; if no approved scanner capacity exists, disable server import rather than bypass the malware gate |
| External categorization stalls a receipt | Five-second abort, no inline retry, circuit breaker, deterministic fallback | Store Uncategorized and continue review |
| Free Supabase Storage fills with originals/derivatives | Measure bytes/page, orphan cleanup, owner deletion, retention decision | Supabase Pro from USD 25/month or compatible private object storage after evaluation |
| High category precision reduces automatic coverage | Treat Uncategorized as a safe outcome | Show ranked suggestions; owner rules improve coverage over time |
| Per-profile learning is sparse | Start with explicit rules/history and require support before High | Medium/Low suggestions; never pool identifiable tenant data |
| Undo removes records that were later edited or referenced | Eligibility checks and compensating deletion by exact imported IDs | Refuse undo and provide a filtered review/export |
| Confidence appears authoritative | Action-oriented bands, visible validation/evidence, correction metrics | Force review for uncalibrated cohorts/providers |
| iOS parity delays Android capstone | State platform support honestly | Manual/gallery capture on iOS; VisionKit after MVP |

## 13. Acceptance criteria

### 13.1 Receipt scanner

**MVP**

- [ ] On each declared physical Android target, Standard capture meets both the retained scanner-harness gates in [Phase 0 benchmark policy v1](phase-0/benchmark-policy-v1.json), pinned there to source SHA-256 `12666143a6cf1e0364110256d0d5e1be033de7e8f0551de3766d2fcdf60b082a`, and the section 9 critical-field targets; no known-cropped vendor, date, currency, or total is labeled complete.
- [ ] Standard mode retains a full-resolution source still plus truthfully labeled rectified and enhanced variants; capture fails recoverably if the full-resolution evidence cannot be produced within limits.
- [ ] Blur, darkness, unstable framing, missing edges, and incomplete capture produce one actionable message within both the retained scanner-harness analysis-latency gate and the section 9 live-guidance p95 target, and never silently discard an image.
- [ ] Long mode meets section 9 line-recall, duplication, and order targets; no known-truncated header, footer, or total is labeled complete, including repeated equal-price fixtures.
- [ ] Reverse motion, lost overlap, lateral drift, early Finish, backgrounding, permission loss, low memory, and cancellation have tested recovery behavior.
- [ ] Source, rectified, composite, and enhanced evidence are truthfully labeled and remain available through review according to retention policy.
- [ ] The native manual-capture request times out or fails recoverably when analysis frames stop. The frozen repeated-session run on the lower-memory target stays at or below its Phase 0 peak-PSS ceiling with no OOM, ANR, or thermal shutdown.
- [ ] A receipt batch contains explicit ordered scan IDs; multi-page scans remain inside one child scan and separate-receipt totals are never merged.
- [ ] Duplicate receipt candidates are profile-scoped, explained, reviewable, and do not block “Save anyway.”
- [ ] Expo Go, iOS, and builds without the native module say Manual rather than claiming automatic scanning.

**Post-MVP**

- [ ] VisionKit supplies iOS standard multi-page capture with the same evidence and confirmation contract.
- [ ] Advanced dewarping or learned guidance ships only after real-receipt non-regression evidence.

### 13.2 OCR and extraction

**MVP**

- [ ] Vendor, invoice number, date/time, items, quantities, unit prices, discounts, tax, subtotal, total, payment method, notes, and category suggestions use one versioned normalized schema.
- [ ] Every non-null extracted value records page/segment, source image/provider, confidence band, and extractor version. Local/provider token boxes are mapped to a normalized region; an unmappable field records `REGION_UNAVAILABLE` and cannot receive a High evidence band.
- [ ] Arithmetic, currency, date, vendor, missing-value, and conflicting-value validations run before review and lower confidence when they fail.
- [ ] Tesseract/local parsing remains usable with all external providers disabled.
- [ ] A clean production worker with outbound network blocked loads every configured checksummed traineddata file locally and completes a cold OCR run.
- [ ] Azure rescue makes zero calls until benchmark, consent, finite budget, and kill-switch tests pass.
- [ ] Provider timeout, invalid response, rate limit, and budget exhaustion preserve the local/manual path.
- [ ] Owner edits are saved atomically with correction evidence and extractor/provider versions.
- [ ] Frozen v1 accuracy gates in section 9 are reported by cohort with exact sample counts; no unsupported production claim is made.

**Post-MVP**

- [ ] PaddleOCR or TrOCR enters production only under a separate versioned Post-MVP policy, frozen before candidate results are opened, that defines the critical metric, paired-interval decision, protected-cohort non-inferiority margins, and compute ceilings.

### 13.3 Receipt upload and processing results

**MVP**

- [ ] Upload progress is based on transferred bytes; processing shows actual named stages and page counts.
- [ ] Success, partial success, failure, cancelled wait, offline return, stale worker, and retry states preserve the scan and owner edits.
- [ ] Failed processing retries the same scan from stored private bytes. Successful or ambiguously timed-out provider submissions are not automatically dispatched again.
- [ ] Upload and retry only enqueue work; automated integration evidence shows the dedicated worker is the sole OCR/provider consumer.
- [ ] The proxy, API, object validator, and tests enforce one aggregate receipt-upload limit; the paired-file worst case cannot be buffered without bound.
- [ ] Low-confidence fields are identifiable without color, keyboard/screen-reader reachable, and linked to the source region or an explicit Region unavailable state.
- [ ] Every selected page or long composite can be viewed at readable size on mobile and web; item name and amount corrections reach the atomic confirm contract.
- [ ] The conditional confirmation transition plus semantic fingerprint lock/recheck produces no duplicate expense record under same-scan or distinct-scan concurrency unless the owner explicitly chooses Save anyway after the recheck; that override and candidate are recorded. An unknown response is resolved by reading current state.
- [ ] Source, rectified, and enhanced receipt read URLs expire after ten minutes and cannot be obtained from another business profile.

### 13.4 Excel/CSV import

**MVP**

- [ ] CSV uploads are identified by content, bounded by bytes and rows, scanned for malware, and rejected safely when unsupported. If `.xlsx` is enabled for the MVP release, its compressed/decompressed, archive-entry, worksheet, formula, encryption, and malware gates all pass first; otherwise the UI offers accurate CSV export guidance and does not advertise Excel support.
- [ ] The file uploads once; parsing and validation resume durably after request or worker failure.
- [ ] Headers, mapping, date convention, currency, categories, and reusable profile-scoped templates are owner-reviewable before import.
- [ ] A 30,000-row CSV meets the section 9 time/RSS gate without loading all result details into an API response or a single database transaction. When `.xlsx` is enabled, every allowed workbook fixture defined in section 9 meets the same condition.
- [ ] Multi-sheet workbooks cannot validate until the owner selects exactly one stored worksheet; remapping or changing it increments the batch version and invalidates stale row results.
- [ ] Every source row has one lifecycle status such as Pending, Validated, Imported, Skipped, or Rejected plus zero or more typed findings. The derived Rejected/Duplicate/Warning/Valid review buckets are mutually exclusive and deterministic.
- [ ] Preview and final summary counts reconcile with durable row results and created records.
- [ ] The complete downloadable error report contains source row, column/value, reason code, owner-safe explanation, and suggested correction, with spreadsheet-formula neutralization.
- [ ] Partial import never reimports successful rows during rejected-only reprocessing.
- [ ] Duplicate detection works within the file and against the active business only.

**Post-MVP**

- [ ] Undo removes only unchanged records created by the target batch, enqueues one profile-analysis refresh, and otherwise refuses with an exact reason.
- [ ] Additional workbook features or larger limits ship only with measured memory, queue, and security capacity.

### 13.5 Automatic categorization

**MVP**

- [ ] Rule precedence is deterministic, versioned, and covered by conflict tests.
- [ ] Owner rules, history, candidates, decisions, and feedback are scoped to one business profile in code and adversarial database tests.
- [ ] High selects a draft automatically, Medium requests confirmation, and Low stays Uncategorized with up to three existing-category suggestions.
- [ ] In MVP, only an active owner-authored rule selects High and remains correctable/disableable. Exact history is at most Medium and model-only output is Low.
- [ ] Every suggestion explains its source without exposing another business's examples.
- [ ] A correction can propose an owner rule, but no rule or category is created without explicit approval.
- [ ] Model outage or disabled API leaves deterministic categorization and manual selection working.

**Post-MVP**

- [ ] A learned/history/model source reaches High only after the section 9 support floor is met, its 95% precision confidence-interval lower bound is at least 95%, and a separate promotion decision is recorded.
- [ ] Any embedding/ML classifier runs in shadow first, stores versioned evaluations, and promotes only after profile-safe accuracy and drift gates.

### 13.6 Security, privacy, and operations

**MVP**

- [ ] New application tables have foreign keys, tenant indexes, RLS enabled, no direct client policies, and explicit/default privilege revokes for `anon` and `authenticated`.
- [ ] Any child that duplicates a profile ID has a composite parent/profile constraint, and mismatch migrations/tests fail at the database boundary.
- [ ] Authenticated-owner and cross-profile tampering tests cover every MVP endpoint, signed URL, row result, rule, mapping, duplicate, retry, consent, and audit path.
- [ ] Production client/API, database, Storage, backup, and provider paths pass TLS/encryption-at-rest configuration checks; temporary and device-cache handling follows section 10.2.
- [ ] API/provider keys are absent from clients, logs, response payloads, repository history, and stored audit metadata.
- [ ] Client `processingError` contains a stable safe code/message only; provider response bodies and receipt text are absent from opaque log strings.
- [ ] Third-party OCR is off by default and requires versioned consent, a finite quota, and an exercised kill switch.
- [ ] Provider-unit reservation is atomic under concurrent multi-page scans and retries. Dispatch ledgers record final or ambiguous estimates and can be reconciled with provider billing; no exact-billing claim is made when a response is lost.
- [ ] Deleting a scan removes that scan's source/derived/OCR/correction/category-provenance/duplicate artifacts through the purge job; deleting an account removes all business-scoped receipt, import, consent, rule, and audit data after Storage cleanup.
- [ ] Automated clocks verify the 1-hour temporary-upload backstop, 24-hour device cache, 7-day abandoned scan, 30-day import/backup, 180-day audit, immediate provider delete request where supported, and Azure's 24-hour automatic maximum.
- [ ] The raw tracked provider benchmark artifact is provenance-reviewed, replaced by sanitized metrics, and any live asset URL is invalidated.
- [ ] Hosted Supabase grants/default ACLs, private Storage policies, backup/restore, and quota alerts are verified in the target environment. Before any real password-based owner account is treated as production-ready, leaked-password protection is enabled, the Pro organization Spend Cap is on, excluded usage and add-ons are inventoried, and no paid add-on exists without explicit owner approval.
- [ ] API and worker deploy on Node 22 or newer, consistent with the current Supabase client support floor and FinSight CI/runtime policy.
- [ ] The final handoff distinguishes automated, emulator, physical-device, synthetic, consented-real, and live-provider evidence.

## Official sources used for cost and capability checks

- [Supabase pricing](https://supabase.com/pricing), [billing overview](https://supabase.com/docs/guides/platform/billing-on-supabase), [cost control](https://supabase.com/docs/guides/platform/cost-control), and [breaking-change changelog](https://supabase.com/changelog?types=breaking-change)
- [Google ML Kit overview](https://developers.google.com/ml-kit/guides), [Document Scanner](https://developers.google.com/ml-kit/vision/doc-scanner/android), and [ML Kit terms/privacy](https://developers.google.com/ml-kit/terms)
- [CameraX image analysis](https://developer.android.com/media/camera/camerax/analyze), [Apple VisionKit](https://developer.apple.com/documentation/visionkit), and [OpenCV license](https://opencv.org/license/)
- [Tesseract.js repository and local installation](https://github.com/naptha/tesseract.js), [PaddleOCR repository](https://github.com/PaddlePaddle/PaddleOCR), [PaddleOCR text recognition](https://www.paddleocr.ai/main/en/version3.x/module_usage/text_recognition.html), and [Microsoft TrOCR](https://github.com/microsoft/unilm/tree/master/trocr)
- [Google Cloud Vision pricing](https://cloud.google.com/vision/pricing), [Vision data use](https://docs.cloud.google.com/vision/docs/data-usage), [Document AI pricing](https://cloud.google.com/products/document-ai/pricing), and [Expense Parser capability](https://docs.cloud.google.com/document-ai/docs/processors-list)
- [Gemini API pricing and free/paid data-use comparison](https://ai.google.dev/gemini-api/docs/pricing)
- [Azure Document Intelligence pricing](https://azure.microsoft.com/en-us/pricing/details/ai-document-intelligence/), [official Southeast Asia price feed](https://prices.azure.com/api/retail/prices?api-version=2023-01-01-preview&currencyCode=USD&%24filter=armRegionName%20eq%20%27southeastasia%27%20and%20productName%20eq%20%27Azure%20Document%20Intelligence%27%20and%20skuName%20eq%20%27S0%27), [service limits](https://learn.microsoft.com/en-us/azure/ai-services/document-intelligence/service-limits), [prebuilt receipt documentation](https://learn.microsoft.com/en-us/azure/ai-services/document-intelligence/prebuilt/receipt), [prebuilt language support](https://learn.microsoft.com/en-us/azure/ai-services/document-intelligence/language-support/prebuilt), and [data privacy](https://learn.microsoft.com/en-us/azure/foundry/responsible-ai/document-intelligence/data-privacy-security)
- [AWS Textract pricing](https://aws.amazon.com/textract/pricing/), [AnalyzeExpense API](https://docs.aws.amazon.com/textract/latest/APIReference/API_AnalyzeExpense.html), and [AI services opt-out](https://docs.aws.amazon.com/organizations/latest/userguide/orgs_manage_policies_ai-opt-out.html)
- [Veryfi pricing](https://www.veryfi.com/pricing/), [receipt API documentation](https://docs.veryfi.com/api/receipts-invoices/process-a-document/), and [privacy policy](https://www.veryfi.com/privacy/)
- [`read-excel-file` repository](https://github.com/catamphetamine/read-excel-file), [ClamAV documentation](https://docs.clamav.net/), and [OWASP CSV injection guidance](https://owasp.org/www-community/attacks/CSV_Injection)
