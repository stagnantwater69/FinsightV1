# FinSight Phase 0 baseline and decisions

**Prepared:** 13 September 2026

**Applies to:** [Cost-first core feature implementation plan](../COST-FIRST-CORE-FEATURES-IMPLEMENTATION-PLAN.md)

**Status:** PARTIALLY COMPLETE

The repository and migration closure needed to start Phase 1 implementation is complete. Local commit `20d011ec8c51fb026abb1d29b53c4f8a196227b7` checkpoints the application, tests, runtime configuration, and all 39 migrations. The hosted database was audited read-only, the migration ledger now matches every local checksum, and the full chain replayed on a fresh disposable database. The corpus and device evidence were inventoried, the benchmark policy was frozen, and the cost, consent, retention, and owner-only scope decisions were recorded. See [P0-CLOSE-01-EVIDENCE.md](P0-CLOSE-01-EVIDENCE.md) and [baseline-lock.json](baseline-lock.json).

The full Phase 0 release gate is still open for three reasons:

1. The scanner release manifest has 0 eligible consented samples. The target is at least 30.
2. No physical Android device was attached, so target-specific peak-memory ceilings and camera evidence do not exist.
3. The hosted account and stored objects have not been classified as synthetic-only or real-owner data. Leaked-password protection is currently disabled.

Phase 1 implementation may now start from the checkpointed candidate. Receipt collection, device testing, and account classification continue in parallel. Those three items still block real-owner rollout, physical-camera claims, and release-accuracy claims.

## Status language

| Label | Meaning |
| --- | --- |
| VERIFIED CURRENT | Directly checked on the 13 September checkpoint candidate or hosted project. |
| DECIDED | Frozen as the implementation default for the next phase. It is not a test result. |
| READY | The dependency gate for local implementation is closed. This is not a release result. |
| HISTORICAL | Existing evidence that was inspected but not regenerated in this Phase 0 run. |
| BLOCKED | Requires owner input, hardware, consented data, or an approved history operation. |

## Phase 0 scorecard

| Workstream | Status | Result |
| --- | --- | --- |
| Current automated baseline | VERIFIED CURRENT | 3,674 tests passed across backend, web, browser, mobile, and ML worker; one backend sentinel test skipped. |
| Type, build, lint, schema, and client parity gates | VERIFIED CURRENT | All commands exited 0. Lint still reports 8 backend, 36 web, and 12 mobile warnings. |
| Hosted schema shape | VERIFIED CURRENT | Current worktree schema has no difference from hosted PostgreSQL 17.6. |
| Hosted direct-data isolation | VERIFIED CURRENT | All 29 public tables use RLS; `anon` and `authenticated` have zero effective application-table and sequence access. |
| Repository checkpoint | VERIFIED CURRENT | Local commit `20d011e` changes 128 repository files relative to `50d7a1f`. Private receipts and local tooling artifacts were excluded. |
| Migration provenance | VERIFIED CURRENT | All 39 local migrations are tracked and match their successful hosted ledger rows; a fresh full-chain replay passed. |
| Corpus inventory | VERIFIED CURRENT | 73 engineering samples exist, but none satisfies the consented owner-receipt release minimum. |
| Scanner release evidence | BLOCKED | 0 of 3 scanner-manifest samples are release-gate eligible. |
| Benchmark and fixture policy | DECIDED | Version 1 is frozen in `benchmark-policy-v1.json` before eligible results are collected, except for the blocked device-specific PSS values. |
| Cost and provider posture | DECIDED | Mandatory metered API budget is USD 0; cloud receipt OCR defaults off; no paid overage is allowed. |
| Consent and retention | DECIDED | The working MVP rules are recorded below. |
| Human users and roles | DECIDED | This deployment has one human Small Business Owner account. No invitations, collaboration, staff, bookkeeper, or administrator scope is planned. |
| Physical device matrix | BLOCKED | Two Android targets and their numeric PSS ceilings still need to be declared and run. |
| Phase 1 work package | READY | `P0-CLOSE-01` is complete. The four independent Phase 1 root tickets may start. |

## Repository baseline

### Working tree

| Item | Value |
| --- | --- |
| Branch | `finsightv1-main` |
| Source base commit | `50d7a1f53e69f493b30cb8e8b25ab66f830a3bc2` |
| Runtime checkpoint | `20d011ec8c51fb026abb1d29b53c4f8a196227b7` |
| State after runtime checkpoint | 0 tracked changes; 18 visible untracked local-only path entries |
| Checkpointed runtime tree | 1,215 Git entries; SHA-256 `15c4fc3b4616f0780a2b143c7f181b2053b868ced9f2fab210f353675d498a6d` |
| Current Prisma schema SHA-256 | `fa01efb2a0de699ecd75bbf6257ab2a96fb12b60c2918f4330bb395813aec816` |
| Present migration SQL files | 39, all tracked |
| Combined present migration-chain SHA-256 | `87c75ea2f583c37d81be14f69ecaadb90df2cdbe980bb72bb820ceceda56216d` |
| Local test runtime | Node 24.18.0, npm 11.16.0, PostgreSQL 16 |
| CI runtime | Node 22, PostgreSQL 16 |

The runtime candidate is recoverable from the checkpoint commit. Receipt images under `RECEIPTS/` are ignored and were not staged. At the runtime checkpoint, documentation and local review or tooling material remained outside that commit. This selected Phase 0 and operational documentation is checkpointed separately; other local artifacts remain untracked and are not dependencies of the runnable candidate.

### Current automated gate

| Area | Command group | Result |
| --- | --- | --- |
| Backend | typecheck, lint, build, Prisma validate, full test | Passed; 137 files, 1,983 tests passed, 1 expected environment-sentinel skip |
| Web | typecheck, lint, build, bundle budget, full test | Passed; 80 files, 685 tests passed; two soft bundle warnings, largest chunk 344.1 KiB |
| Browser | Playwright Chromium | 10 of 10 journeys passed with mocked Auth and backend requests |
| Mobile | typecheck, lint, full test | Passed; 92 files, 983 tests passed |
| Shared contracts | client type-parity check | 91 shared types match |
| ML worker | Python unit discovery | 13 tests passed |
| Working tree | whitespace check | Passed at the end of the QA lane |

The backend integration suite used a local PostgreSQL database and mocked Supabase Auth, Storage, OCR, and AI providers. Mobile tests mocked the camera, gallery, native scanner view, API, and lifecycle events. Passing automation is regression evidence, not physical camera, hosted workflow, or live-provider evidence.

The original full gate restored its stopped local test database state. The migration-closure run later removed its disposable test database, so no scratch or test container remained. No external OCR, AI, Auth, Storage, or paid-provider call was made by either local QA lane.

## Migration and hosted database audit

### What passed

- `npm run db:check:direct` reached hosted Supabase.
- `npx prisma migrate status` reported 39 migrations and an up-to-date database.
- A hosted-to-current-worktree Prisma diff reported no difference.
- All 39 unique hosted migration names exist locally, and all 39 local names exist hosted.
- Current read-only consistency probes found no cross-profile mismatches and no receipt scan with a null business profile.

### Migration closure result

Hosted `_prisma_migrations` contains 40 rows for 39 unique migration names. The extra row is a recorded rolled-back attempt for `20260727125237_add_notification_expense_record`, which is not itself a schema problem.

Both provenance findings are resolved:

| Migration | Resolution | Evidence |
| --- | --- | --- |
| `20260910152035_receipt_upload_idempotency` | Tracked in checkpoint `20d011e`. | Local and hosted SHA-256 are `3b5139f660bfb4aa5bffe1e9cf55ab609020a23b6f5855ec63e1d5393bc76fdf`. |
| `20260804140000_receipt_field_corrections` | Restored byte-for-byte from recovered Git blob `80d438a71a1a64def5ba2b4e54cb2015595e4612`. | Local and hosted SHA-256 are `26f844620564e83919cc75393594e7028c8b77d8c6d658990d28ba075271d7fa`. |

The recovered file differs from the previous working copy only by a later-added RLS statement and its comments. The immediately following migration, `20260806153854_secure_application_tables_from_data_api`, already enables RLS for `ReceiptFieldCorrection`, so the final schema is unchanged. The sanctioned validation replayed all 39 migrations, ran the 1,983-test backend suite with one expected skip, and removed its scratch databases. The hosted audit then found no schema difference, no missing or unapplied migration, and no checksum mismatch. No `prisma migrate resolve`, hosted DDL, hosted DML, or migration application was performed.

### Hosted isolation and Storage

The hosted project was queried read-only and was active on PostgreSQL 17.6. Email signup is currently enabled, email confirmation is required, and phone signup is disabled. For the requested private single-owner rollout, provision the owner account first and then disable new public signup. The audit did not change Auth settings.

- All 29 tables in `public` have RLS enabled.
- `anon` and `authenticated` have zero effective `SELECT`, `INSERT`, `UPDATE`, or `DELETE` privileges across those tables.
- The same roles have no `USAGE` on the 26 public sequences.
- There are no public RLS policies, public views, or public security-definer functions.
- Default public table and sequence privileges include only `postgres` and `service_role`.
- Default privileges still allow client-role execution of future public functions. No public function exists now, so this is a hardening ticket rather than a current exposure.
- `storage.objects` and `storage.buckets` have RLS. There are no object policies, so client-role operations are denied while the backend service client can operate.
- `receipts` and `csv-imports` are private. `avatars` is intentionally public.
- Receipt and CSV signed URLs expire after 600 seconds.
- The three buckets currently have no bucket-level MIME or object-size restrictions.

The audit counted 381 stored objects totaling 59,001,254 bytes: 334 receipt objects, 35 CSV import objects, and 12 avatar objects. These are aggregate counts only; no file name, receipt content, signed URL, or credential was read into this report.

The intentional no-policy posture explains the Supabase Security Advisor informational notices for RLS-enabled tables with no policy. The current advisor also reports leaked-password protection disabled. This remains acceptable only for synthetic capstone accounts and must be enabled before any real-user credential rollout. Performance advice currently identifies three unindexed foreign keys: `AuthHandoff.User_ID`, `Conversation.BusinessProfile_ID`, and `ReductionOpportunityFeedback.User_ID`. Existing unused-index notices are not permission to delete indexes without workload evidence.

Supabase is changing automatic Data API exposure for public tables on 30 October 2026. FinSight should still keep explicit grants, revokes, and RLS checks because grants and policies are separate controls and the repository needs a stable posture before and after the platform default changes. See the [Supabase change notice](https://supabase.com/changelog/45329-breaking-change-tables-not-exposed-to-data-and-graphql-api-automatically).

### Database defense-in-depth findings

Application validation currently protects several same-profile relationships, and the read-only probes found no existing mismatch. The database has 44 foreign keys but no composite foreign keys that enforce matching `BusinessProfile_ID` across related category, receipt, import, notification, anomaly, schedule, or statistics rows. `ReceiptScan.BusinessProfile_ID` is also nullable with `ON DELETE SET NULL`, although the account-deletion service deletes scans first. These are P2 defense-in-depth items, not evidence of a current cross-owner record.

## Receipt and OCR evidence baseline

### Engineering corpus

| Group | Samples | What it can support |
| --- | ---: | --- |
| `real` label | 45 | Parser engineering only at present |
| Synthetic | 19 | Deterministic regression tests |
| Synthetically degraded | 9 | Controlled degradation regression tests |
| Total | 73 | Engineering baseline, not a production claim |

Of the 45 samples labeled `real`, 42 came from publicly licensed third-party datasets. Their labels were reviewed once by an AI reviewer, not independently transcribed by two people or confirmed by the original receipt owners. The original three samples also lack recorded consent in the scanner manifest. Public licensing is useful for engineering, but it does not satisfy the plan's consented owner-receipt minimum.

There is also a provenance contradiction to repair: corpus attribution calls all three original samples Philippine real photos, while `real-02-clean-digital` is described in ground truth as a clean digital US receipt. Market-coverage reporting must not count it as a Philippine phone photo until that record is corrected.

### Existing saved OCR result

This result is HISTORICAL. Phase 0 did not rerun the evaluator because its current command overwrites saved result artifacts.

| Metric | Saved result |
| --- | ---: |
| Date exact result | 41 of 61, 67% |
| Vendor result | 44 of 60, 73% |
| Amount exact result | 49 of 73, 67% |
| All three correct or legitimately absent | 37 of 73, 51% |
| Line-item amounts found | 130 of 216, 60% |
| Correct names among matched items | 120 of 130, 92% |
| Quantities correct | 34 of 77, 44% |
| False-positive item lines | 14 |

These values are a parser baseline against mixed evidence. They are not release accuracy and must not be presented as Philippine-market performance.

### Scanner release evidence

The scanner manifest contains three samples and marks 0 of 3 release-gate eligible. Consent, capture source, capture mode, and original/processed pairing are missing, so release document precision, recall, false-trigger rate, multi-receipt accuracy, and handwritten rejection rate are not measurable. The saved 206.4 ms detector p95 is diagnostic only.

Use the header-only [receipt intake example](receipt-corpus-intake.example.csv) and [pair-label example](receipt-pair-label.example.csv) according to the [corpus data dictionary](CORPUS-DATA-DICTIONARY.md). Never populate the tracked examples. Keep images, populated manifests, pair labels, and ground truth encrypted outside Git. A sample becomes eligible only after its logical receipt ID, capture attempt, count role, source class, provider-specific consent scope, permitted use, source and sealed-ground-truth hashes, device/mode provenance, sealed cohort and vendor-template tags, redaction state, retention date, and two independent human ground-truth reviewers are recorded before any result is opened.

## Frozen benchmark policy

[benchmark-policy-v1.json](benchmark-policy-v1.json) is the exact Phase 0 policy for the next eligible run. It pins the hashes of the corpus dictionary and both header-only CSV schemas, so changing an eligibility predicate or input column requires a policy-version update before results are opened. Its important limits are:

- at least 30 unique consented real receipts for capstone evidence;
- at least 5 receipts in each required condition cohort, with overlapping tags allowed;
- distinct receipt IDs are the counting unit; pages, segments, derived variants, and recaptures never inflate receipt, vendor-template, or cohort counts;
- at least 10 non-receipts, 10 known duplicate pairs, and 20 known non-duplicate pairs;
- no vendor template above 20% of the receipt set;
- synthetic and public-dataset samples never fill a consented real-receipt minimum;
- at least 100 real receipts, including 30 in each affected receipt cohort, for an OCR-provider promotion decision;
- at least 300 confirmed category decisions within the same business profile for a Post-MVP learned category promotion decision; another profile's decisions cannot contribute and the precision interval is computed per profile;
- at least 100 duplicate and 200 non-duplicate pairs for a duplicate-detector promotion decision;
- evidence from one decision type never fills another decision type's support floor;
- all gates already frozen in `backend/tests/receipt-scanner-evaluation/thresholds.json` remain in force and are not superseded by this broader policy;
- exact receipt, categorization, duplicate, performance, safety, CSV, and optional `.xlsx` gates frozen before labels are used for selection;
- numerator, denominator, point estimate, and an applicable confidence interval required for every reported gate;
- `UNCALIBRATED` required wherever the evidence floor is not met.

Phase 0 does not claim a separate statistical power result. Policy v1 fixes minimum support and maps every planned metric family to one interval method. Binary sample, field, category-decision, and pair proportions use a two-sided 95% Wilson score interval without continuity correction. Clustered line/item/text, correction, calibration, continuous-error, latency, and memory metrics use a two-sided percentile bootstrap with 10,000 resamples and the frozen seed, at the distinct receipt or declared independent-trial unit specified in the policy. The explicit map takes precedence, and an unlisted metric needs a versioned method before an eligible result. Provider differences use paired receipt-level bootstrap resampling, and every affected cohort must meet its applicable point gates independently. Only Post-MVP learned-category High uses the lower endpoint as a promotion threshold. OCR-provider and duplicate decisions use their frozen point gates plus a reported interval and safety/review controls; they do not support a production accuracy claim. Any support or interval-method change requires policy v2 before the first eligible result is opened and cannot be lowered after seeing outcomes.

The per-device peak-PSS field is intentionally `null` and marked blocked. A numeric limit cannot be assigned to an unknown device without fabricating a hardware claim. It must be filled for each declared target before its first measured run, without changing it after results are seen.

## Frozen product and cost decisions

### D0-01: one human owner

This FinSight deployment has one human user with one Small Business Owner account. There is no invitation, collaboration, delegated approval, staff, bookkeeper, administrator, or multi-user permission interface. The owner can capture, review, import, categorize, confirm, and delete data for the active business. Active-business ownership checks remain mandatory because the owner may hold more than one business profile and because isolation is still a security boundary.

The two-human ground-truth check belongs only to the private evaluation process. Those reviewers do not receive FinSight product accounts or become staff/bookkeeper roles.

### D0-02: zero mandatory metered API cost

- Mandatory metered API budget: USD 0 per month.
- Synthetic capstone hosting: Supabase Free while its measured quotas fit.
- Real password-based owner rollout: Supabase Pro, currently starting at USD 25 per month, or an approved equivalent that satisfies leaked-password and backup requirements.
- Supabase Pro cost control: turn the organization Spend Cap on, inventory excluded usage and add-ons, keep the included compute class, permit no paid add-on without explicit owner approval, and verify the settings plus upcoming invoice at release. The cap does not cover every chargeable item. See [Supabase cost-control documentation](https://supabase.com/docs/guides/platform/cost-control).
- Production cloud receipt OCR: disabled by default.
- Paid overage: not allowed.
- Initial Azure benchmark: at most 100 page units per calendar month, only on a verified F0 resource and only after eligible corpus, consent, region, and atomic reservation gates pass. No S0 paid benchmark is approved.
- Later Azure production candidate: at most 450 F0 page units per month, but only after a passing benchmark and a separate promotion decision. It is not approved by Phase 0.
- Veryfi: disabled, with 0 approved units in this phase. Its free allowance is not a reason to accept an unlimited configuration or its paid minimum.
- Gemini developer free tier: no real financial receipts.
- Budget exhaustion or provider failure: local OCR plus owner review.
- The FinSight reservation cap governs FinSight dispatches, not other callers using the same Azure resource. Use a dedicated resource or reconcile external usage before every dispatch.
- Local software still consumes hosting CPU, memory, storage, and operational effort. Zero metered API cost does not mean zero infrastructure cost.

### D0-03: local-first reading and categorization

Receipt and import processing must use the free deterministic path first:

1. Read and validate the image or CSV locally.
2. Apply arithmetic, date, currency, ownership, and duplicate checks.
3. Apply explicit owner category rules, exact confirmed vendor/description history, then normalized keywords.
4. Show ranked reviewable suggestions when confidence is not calibrated.
5. Use a cloud receipt adapter only for an approved uncertain-field rescue, never for every receipt.

An owner-authored rule is an instruction and is the only High category source in MVP. Exact confirmed history is at most Medium and model-only output is Low. A learned source can reach High only Post-MVP, after its 95% precision confidence-interval lower bound is at least 95%, all frozen support gates pass, and a separate promotion decision is recorded. New categories are never created without owner approval.

### D0-04: cloud consent

Before the first cloud receipt dispatch, FinSight must show and store the consent version, provider category, data sent, purpose, configured region, retention link, and revocation behavior. Consent is scoped to the active business and provider purpose. Revocation stops future calls. Dispatch metadata may contain safe IDs, units, versions, outcome codes, and timestamps, but not receipt text, item/vendor payload, payment details, signed URLs, or provider response bodies.

No call is allowed without current consent, an atomic reserved unit, a finite monthly cap, a timeout, and an active kill switch. An ambiguous provider timeout is not retried automatically because the first request may already be billable.

### D0-05: working MVP retention policy

This is a product default, not jurisdiction-specific tax or legal advice.

| Data | Working MVP rule |
| --- | --- |
| Server temporary upload | Delete immediately after verified private upload or request failure; hourly orphan sweep as backstop. |
| Pending or failed receipt draft and derived data | Delete 7 days after last activity unless resumed or deleted sooner. |
| Confirmed receipt evidence | Retain until the owner deletes or detaches it, or deletes the financial record. Keep confirmed amount/category history when only the image is detached. |
| Completed or failed import source and repair values | Delete after 30 days unless a reprocess is active. Keep minimized aggregate provenance. |
| Mobile scanner cache | Delete on confirm, discard, logout, and account deletion; sweep anything older than 24 hours. |
| Provider-side input/result | Delete immediately after normalized ingestion when the provider supports it; do not rely on a period longer than 24 hours for an approved receipt provider. |
| Minimized security audit event | Retain 180 days without receipt content or financial payload. |
| Backup containing deleted data | Cap retention at 30 days when backups are enabled and document expiry behavior. |

Configurable per-business retention and redaction remain Post-MVP because this is a single-owner product with a fixed MVP policy. Any Philippine tax-record requirement must be reviewed by a qualified adviser before changing these defaults.

### D0-06: file formats

CSV remains the only advertised import format, but it does not meet the MVP gate until Phase 4A adds fail-closed ClamAV/content scanning for every upload. `.xlsx` stays disabled until it reuses that scanner and also passes OOXML structure limits, exact decimal handling, formula/macro/external-link rejection, workbook fixtures, and host-memory measurements. ClamAV has no license or per-call fee, but no scanner, signature updater, service, or integration exists in the current environment.

## Runtime and deployment findings routed to Phase 1

These are verified gaps, not new Phase 0 feature work:

- Receipt upload and manual retry still invoke `claimAndProcessScan()` from the API process. The separately deployed worker is not the exclusive OCR consumer.
- Multer buffers up to 16 files at 10 MiB each, while nginx accepts about 88 MiB. A valid paired request can approach 160 MiB plus overhead.
- `backend/eng.traineddata` is present at 5,199,098 bytes with SHA-256 `5dc5d8d640a212c9d6184921ba103b186f50e0fed9ee716c53e6b312b400d747`, but the Dockerfile does not copy it and OCR does not set a local language-data path.
- The worker has no health signal and processes receipt, CSV, analysis, and deletion queues through one sequential busy gate.
- CI uses Node 22 while the production base image uses a mutable Node 24 tag and the package files declare no engine.
- No ClamAV or `.xlsx` path exists, which correctly keeps Excel import out of the current product and leaves current CSV import below the new MVP acceptance gate.
- There is no demonstrated recursive database plus Storage backup and restore. Supabase Auth identities and Storage objects are not covered by a PostgreSQL dump.
- A non-empty `GOOGLE_GEMINI_API_KEY` can currently enable receipt vision work without a separate global receipt-provider switch. The zero-by-default decision is not an enforced runtime control until P1-BE-04 closes it.
- `VERYFI_ENABLED` defaults false, but an unset `VERYFI_MONTHLY_LIMIT` becomes unlimited if it is enabled. Phase 1 replaces this with fail-closed reservation behavior.

The fixes are sequenced in [PHASE-1-BACKLOG.md](PHASE-1-BACKLOG.md). That backlog keeps Tesseract and deterministic logic as the no-metered-fee core and places optional Azure work behind the eligible benchmark.

## Physical Android protocol

The existing [physical-device checklist](../mobile-camera-verification-checklist.md) remains the procedural source. Phase 0 freezes these run counts:

- one target near the minimum supported API and RAM class;
- one mainstream target;
- 90 seconds maximum for one Long session;
- 10 repeated Standard sessions per target;
- 5 repeated Long sessions per target;
- 5 background/resume cycles per target;
- no OOM, ANR, or thermal shutdown;
- numeric peak-PSS ceiling per target, set after recording device RAM/memory class and before the first measurement.

`adb devices -l` found no attached device. Stored emulator and instrumentation evidence uses synthetic inputs and does not satisfy this gate.

## Remaining actions to close Phase 0

### Completed implementation prerequisite

`P0-CLOSE-01` is complete. Commit `20d011e` preserves the reviewed runtime candidate, including the hosted-applied receipt-upload-idempotency migration. The recovered receipt-field-corrections artifact now matches the hosted checksum. Fresh migration replay, backend regression, hosted status, hosted ledger comparison, schema diff, RLS, and effective client-privilege checks passed. Phase 1 implementation may proceed.

### Owner and QA action 1: collect eligible evidence

Copy the header-only intake and pair-label examples according to the data dictionary, keep populated files and images private and encrypted outside Git, obtain two independent transcriptions, and mark eligibility only after every required field is present.

### Owner and QA action 2: declare and run devices

Record two Android devices, build and scanner mode, OS/API, RAM, memory class, camera output, and thermal start. Freeze each numeric PSS ceiling, then execute the checklist and attach safe evidence.

### Security action 3: confirm the account type

If the hosted account uses only synthetic capstone credentials, the current leaked-password setting may remain a documented exception on Supabase Free. Supabase currently lists leaked-password protection as unavailable on Free. If any real password-based owner credential is in use, move to Supabase Pro, currently starting at USD 25 per month, or an approved equivalent control, and enable leaked-password protection before continuing real-data rollout. For this private single-owner deployment, provision the owner first and disable new public signup. On Pro, turn on the organization Spend Cap, inventory every excluded usage item or add-on, retain the included compute class, and require explicit owner approval before a paid add-on. Verify the cost controls and upcoming invoice in the target organization at release. Given the existing Auth, Database, and Storage integration, Pro is the lower-risk production recommendation. See [Supabase pricing](https://supabase.com/pricing) and [cost-control documentation](https://supabase.com/docs/guides/platform/cost-control).

## What happens after Phase 0

| Next phase | Outcome |
| --- | --- |
| 1. Worker, upload, and cost guardrails | Worker-only OCR, bounded uploads, offline Tesseract, consent, atomic free-tier budget, safe provider failures. |
| 2. Scanner acceptance and results | Physical Android proof, source-image integrity, memory/lifecycle fixes, clearer page and correction review. |
| 3. Extraction and provider benchmark | Expanded structured receipt fields and Tesseract versus optional Azure F0 evidence. Cloud stays off if no candidate passes. |
| 4A. CSV completion | Upload once, mandatory fail-closed ClamAV/content scanning, durable row outcomes, complete error report, partial recovery, and rejected-row reprocess. |
| 4B. Optional safe `.xlsx` | Reuse the mandatory malware scanner, then enable only if OOXML, precision, and resource gates pass. Otherwise remain CSV-only. |
| 5. Automatic categorization | Owner rules, confirmed history, keywords, confidence bands, explanation, and measured correction outcomes. |
| 6. Release gate | Full security, hosted, restore, capacity, device, corpus, UAT, and cost-control evidence. |

Current receipt OCR and category suggestion already exist. These phases harden and measure them rather than rebuilding the product from zero.

## Completion checklist

- [x] Record the current repository, runtime, test, corpus, hosted schema, RLS, grants, Storage, and deployment baseline.
- [x] Freeze the one-human-owner scope and remove invented collaboration, staff, bookkeeper, and administrator work.
- [x] Freeze the no-paid-overage cost posture and staged provider order.
- [x] Freeze consent, retention, corpus, fixture, metrics, and reporting policies.
- [x] Produce header-only corpus examples, their data dictionary, and the executable Phase 1 backlog.
- [x] Preserve an intentional repository checkpoint without private receipts, credentials, or local tooling artifacts.
- [x] Reconcile the historical migration checksum, track the hosted-applied migration, and replay the full chain.
- [ ] Populate the minimum eligible consented corpus.
- [ ] Declare the two Android targets, freeze numeric PSS limits, and run physical verification.
- [ ] Record whether the hosted project is synthetic-only; for real password-based use, enable leaked-password protection, disable new signup after owner provisioning, close the backup control, enable the Pro Spend Cap, and verify excluded usage/add-ons and the upcoming invoice.

Phase 0 should change to COMPLETE only when the three unchecked release items have recorded evidence. Until then, the accurate status is PARTIALLY COMPLETE and Phase 1 implementation is ready.
