# Phase 2 acceptance checklist

**Prepared:** 13 September 2026

**Status:** Open; all four P1 findings and all eight P2 findings are fixed and locally verified as of 14 September 2026, while external acceptance remains open and nothing is committed

**Scope:** Receipt scanner, recoverable processing, review, duplicate handling, confirmation, and evidence deletion

Phase 2 is a review candidate, not an accepted release. The four P1 and eight P2 review findings now have local fixes and regression evidence. This checklist separates that repository evidence from the checks that require private receipts, physical Android devices, deployed credentials, or explicit hosted authorization.

The evaluator described below does not run OCR, open receipt images for scoring, or contact a provider. It validates a sealed external corpus and aggregates caller-prepared scored observations. Its output cannot close physical-device, deployed-storage, operational, or ownership-isolation gates.

## Current review blockers

Do not merge or describe Phase 2 as accepted while the external acceptance gates remain open and the P2 snapshot has not been committed, independently reviewed, and passed through hosted CI.

### P1, fixed and locally verified

- [x] [Review finding 1](./PR-1-REVIEW-2026-09-13.md#1-deleting-an-in-flight-scan-can-lose-the-race-with-external-provider-dispatch): final provider submission now locks and revalidates deletion, scan state, delete-purge absence, and the exact worker lease. [`receiptProviderDispatch.test.ts`](../../backend/tests/integration/receiptProviderDispatch.test.ts) proves deletion-before-submission and stale or lost leases produce zero adapter calls, cancel the reservation, and charge no units.
- [x] [Review finding 2](./PR-1-REVIEW-2026-09-13.md#2-a-crash-on-the-final-purge-attempt-can-strand-the-deletion-forever): [`receiptPurge.service.ts`](../../backend/src/services/receiptPurge.service.ts) terminalizes stale or queued max-attempt jobs, readiness reports them, and a fresh final lease remains active. [`phase2ReceiptAcceptance.test.ts`](../../backend/tests/integration/phase2ReceiptAcceptance.test.ts) covers each state.
- [x] [Review finding 3](./PR-1-REVIEW-2026-09-13.md#3-mobile-choose-another-receipt-leaves-capture-disabled): [`ScanReceiptScreen.tsx`](../../mobile/src/screens/records/ScanReceiptScreen.tsx) uses the complete reset path. [`receiptImportFlow.test.tsx`](../../mobile/tests/render/receiptImportFlow.test.tsx) covers single, batched, and resumed foreign-currency scans and proves the next upload uses a fresh identity without an old batch binding.
- [x] [Review finding 4](./PR-1-REVIEW-2026-09-13.md#4-an-earlier-applied-revision-of-the-phase-2-migration-is-treated-as-current): the forward-only [`20260913230000_reconcile_phase2_scanner_migration_drift`](../../backend/prisma/migrations/20260913230000_reconcile_phase2_scanner_migration_drift/migration.sql), SHA-256 `d2f4805aef790c484fd1878edecfcba0a39b93529cb8d9b0879469e2aaa99d46`, repairs only the exact supported legacy shape. [`migrationGuard.ts`](../../backend/src/config/migrationGuard.ts) fails closed on unsupported checksums, altered CHECK/FK/index semantics, missing migration assets, and reachable ledger or catalog inspection failures. [`verify-phase2-reconciliation.ts`](../../backend/scripts/migrate-workflow/verify-phase2-reconciliation.ts) executes the legacy upgrade and malformed-state rejection against disposable PostgreSQL.

### P2, fixed and locally verified on 14 September 2026

Each item links to its evidence in the [P2 resolution table](./PR-1-REVIEW-2026-09-13.md#p2-resolution-14-september-2026).

- [x] Resolve [review finding 5](./PR-1-REVIEW-2026-09-13.md#5-seven-day-abandoned-scan-cleanup-is-missing) by adding the missing seven-day abandoned-scan sweep or recording an approved scope decision. Sweep added: forward-only migration `20260914010610_receipt_scan_last_activity`, hourly worker sweep, activity stamps, and [`receiptAbandonedScanSweep.test.ts`](../../backend/tests/integration/receiptAbandonedScanSweep.test.ts).
- [x] Resolve [review finding 6](./PR-1-REVIEW-2026-09-13.md#6-confirmation-can-return-an-error-after-financial-records-commit) by removing or safely reporting the post-commit side-effect failure that can return HTTP 500 after the financial commit succeeds. Noncritical effects are isolated and logged with safe identifiers; [`receiptConfirmPostCommit.test.ts`](../../backend/tests/integration/receiptConfirmPostCommit.test.ts).
- [x] Resolve [review finding 7](./PR-1-REVIEW-2026-09-13.md#7-mixed-confirmation-payload-modes-are-accepted-and-partly-ignored) by making confirmation payload modes consistent and rejecting mixed modes deterministically. Two-mode contract in [`confirmMode.ts`](../../backend/src/services/receiptScan/confirmMode.ts); contract and integration suites named `receiptConfirmModes`.
- [x] Resolve [review finding 8](./PR-1-REVIEW-2026-09-13.md#8-duplicate-candidate-handling-is-not-bounded-by-its-pagination-contract) by bounding or paginating duplicate candidate-set handling so it scales predictably. 200-candidate cap, database cursor pagination, bulk persistence; [`receiptDuplicateCandidateBounds.test.ts`](../../backend/tests/integration/receiptDuplicateCandidateBounds.test.ts).
- [x] Resolve [review finding 9](./PR-1-REVIEW-2026-09-13.md#9-mobile-evidence-page-switching-can-leave-a-permanent-loading-veil), the evidence-view loading race. Per-key loading state; [`receiptEvidenceViewerLoading.test.tsx`](../../mobile/tests/render/receiptEvidenceViewerLoading.test.tsx). Physical-device verification still required.
- [x] Resolve [review finding 10](./PR-1-REVIEW-2026-09-13.md#10-web-recovery-history-hides-scans-beyond-its-first-page) by implementing and testing receipt-history cursor pagination or load-more behavior. `Show older scans` with cursor forwarding; [`ScanReceipt.recoveryHistory.test.tsx`](../../web/src/pages/ScanReceipt.recoveryHistory.test.tsx).
- [x] Resolve [review finding 11](./PR-1-REVIEW-2026-09-13.md#11-newly-abandoned-web-scans-do-not-enter-recovery-history-until-reload) by refreshing history after a scan is abandoned and preserving a visible retry path when refresh fails. Local seeding plus refresh and `Reload unfinished scans`; same suite.
- [x] Resolve [review finding 12](./PR-1-REVIEW-2026-09-13.md#12-repeated-web-recovery-actions-have-ambiguous-accessible-names) with receipt-specific accessible action names or descriptions and a multiple-row assertion. Row-specific `aria-label`s; seven-row unique-name assertion and e2e selectors by unique name.

The P1 items above record implemented and locally verified fixes. The P2 items remain open; this document does not claim that any P2 finding has been fixed or waived.

## P1 local verification

- [x] Focused backend P1 tests passed 90 of 90 across provider dispatch, Phase 2 receipt acceptance, and migration guard coverage.
- [x] Focused mobile receipt-flow tests passed 48 of 48.
- [x] The full mobile suite passed 97 files and 1,056 tests under Node 22.
- [x] The full backend suite passed under Node 22.23.2 on a fresh disposable PostgreSQL database: 151 files, 2,245 passed, 1 skipped, and 2,246 total. All 44 migrations applied, migration status was up to date, the Prisma schema diff reported no difference, and the live startup guard returned `ok` with no schema issues.
- [x] The supported-legacy reconciliation fixture and the fresh chain both produced no Prisma schema difference and the same 235-fact canonical Phase 2 catalog and security digest. The committed executable legacy harness also reports a clean startup guard, while weakened legacy constraints and altered index predicates, collations, or operator classes fail closed and roll back without leaving repair objects.
- [x] Test database URLs pinned both `DATABASE_URL` and `DIRECT_URL` to disposable local databases. The final full-suite database was removed after zero remaining sessions.

## P2 snapshot verification, 14 September 2026

All commands ran under Node 22.23.2 with `DATABASE_URL` and `DIRECT_URL` pinned to disposable local PostgreSQL 16 databases. The snapshot is HEAD `28394be` plus the uncommitted worktree; complete backend, mobile, and web unit suites ran on tracked-diff SHA-256 `9d9a81e4f0c8e9080ad630e9ba5cd283839e7a52715c13fc2aa40850ff2b07a1`, after which the only change was a one-line e2e selector in `web/e2e/phase2-receipt-review.spec.ts`, and the final Chromium run used tracked-diff `bf9248724f7e495fc2eed4096443927ed6524d6128df6d2fbf5db24850cb8cc3`.

- [x] Stage 0A closed first: the exact P1 snapshot (tracked-diff `08d93d04cba4652d04a5af4f7285c8d16dafc038cc5a5c6c5a0bbf43474ba7ed`) passed the complete backend suite on a fresh database with the frozen reconciliation migration unchanged: 151 files, 2,245 passed, 1 skipped, 2,246 total, 44 migrations, status current, diff clean, guard `ok`, zero remaining sessions.
- [x] Fresh replay of all 45 migrations on PostgreSQL 16.15; `prisma validate` clean; `prisma migrate status` current; `prisma migrate diff --exit-code` reported no difference; live guard returned `{status:ok,pending:[],failed:[],checksumMismatches:[],schemaIssues:[]}`; ledger shows 45 finished rows.
- [x] Reconciliation harness: fresh and supported-legacy paths share 237 facts at digest `eb4d357dd91fe66da9f52557dc500b9b6859ed5da9a8f48deedbea886d9c8c50`; malformed legacy, predicate, collation, and operator-class states rejected; harness containers removed.
- [x] Complete backend suite: 156 files, 2,305 passed, 1 skipped, 2,306 total; type-check, lint (8 pre-existing warnings, none in changed files), and production build passed; zero remaining database sessions.
- [x] Complete mobile suite: 98 files, 1,064 passed; type-check and lint passed with the 12 pre-existing Fast Refresh warnings.
- [x] Complete web suite: 85 files, 745 passed; type-check, lint (pre-existing Fast Refresh warnings only), production build, and bundle budget (78 chunks within budget) passed; Chromium end-to-end 18 passed with `CI=1`.
- [x] Policy-v1 evaluator: 75 passed, focused type-check and lint clean.
- [x] Backend CI steps reproduced locally: shared client-type parity (91 types match), provider gate smoke (7 of 7, zero provider network calls), queue readiness smoke, `receipt-provider:status --require-disabled` (dispatch disabled, kill switch active), queue readiness `ok`, `docker compose config` valid. Not reproduced: `npm audit`, the Docker image build job, the ML worker job, and hosted CI itself, which has only push and pull-request triggers.
- [x] `git diff --check` clean; no `.env` file appears in the worktree changes.
- [x] Independent full-range review performed on 14 September ([PR 2 review](./PR-2-REVIEW-2026-09-14.md)): two P1 and eleven P2 clusters fixed in the same session with reproducing tests; four P2 items await an owner disposition; 37 P3 items recorded as backlog.

## Post-review snapshot verification, 14 September 2026

After the PR 2 fixes, on the snapshot with tracked-diff SHA-256 `c839590ac02a6f841d9882402460b958fdaf9429ffa561665f7a4e3549f02c01` (HEAD `28394be` plus the worktree):

- [x] Backend, on a fresh disposable PostgreSQL 16 database: `prisma validate` clean, all 45 migrations applied, status current, schema diff clean, live guard `ok`; complete suite 158 files, 2,313 passed, 1 skipped, 2,314 total; type-check, lint (8 pre-existing warnings), and production build passed; zero remaining database sessions.
- [x] Web: 85 files, 748 passed; type-check, lint, production build, bundle budget, and Chromium end-to-end 18 passed with `CI=1`.
- [x] Mobile: 98 files, 1,069 passed after the two PR 2 mobile dispositions were fixed; type-check and lint passed with the 12 pre-existing Fast Refresh warnings.
- [x] Reconciliation harness with the extended guard: 237 facts at `eb4d357dd91fe66da9f52557dc500b9b6859ed5da9a8f48deedbea886d9c8c50`; malformed states rejected.
- [x] `git diff --check` clean.
- [x] Owner dispositions recorded for the four open P2 items in the PR 2 review (one accepted with a runbook requirement, two fixed, one deferred to after merge).
- [ ] A reviewed commit and hosted CI on that exact SHA remain open.
- [ ] Hosted deployment and authorized hosted verification remain open. Three accidental SELECT-only verification entrypoints reached the hosted database during follow-up, made no write or migration, accessed no user or receipt data, and do not count as an acceptance pass. The owner personally deployed `20260913192200` and `20260913194745` on 13 September and `20260913230000` and `20260914010610` at about 02:07 on 14 September from the interactive shell to keep the development server running; the hosted ledger is expected to hold all 45 migrations, unverified by an authorized check. See [HOSTED-MIGRATION-INCIDENT.md](./HOSTED-MIGRATION-INCIDENT.md).
- [ ] Physical-device camera acceptance remains open. Local render, unit, integration, and Android automation cannot close it. Owner-reported on 14 September 2026 at about 02:10 PHT: the standalone Android APK on a Poco X6 5G (Android version not yet recorded) reached the development API over Tailscale and signed in successfully after the owner deployed the two outstanding migrations. That is connectivity and auth evidence only; no capture, evidence-viewer, reset, or lifecycle journey was exercised.

## Frozen inputs

- [ ] Use policy ID `finsight-core-evidence-gates-v1`.
- [ ] Verify [benchmark-policy-v1.json](../phase-0/benchmark-policy-v1.json) has SHA-256 `4368086c7ef0ae38be67d7c510c91b7b8cc37fb383a179e6ab543cfb2039650f`.
- [ ] Keep the retained scanner thresholds at the policy-pinned SHA-256.
- [ ] Keep the data dictionary and both header-only CSV examples at their policy-pinned SHA-256 values.
- [ ] Store populated intake, pair labels, artifact paths, ground truth, source files, scored observations, and reports outside the repository.
- [ ] Freeze the manifest, pair-label file, artifact map, and ground-truth bundle before anyone opens provider or model results.
- [ ] Record two distinct human custodian IDs for every eligible receipt and pair.

The validator checks that reviewer IDs are present, distinct, and do not use common model or OCR-system identifiers. This is a structural declaration check. It does not independently prove that the reviewers are human or that they reviewed the source correctly. Corpus custodians must verify reviewer identity and agreement outside the tool.

## External evaluator inputs

Run the command from `backend/`. Every private input and the output must use an absolute path outside the Git worktree.

```bash
npm run evaluate:receipt-scanner:policy-v1 -- \
  --manifest /approved-private-store/intake.csv \
  --pairs /approved-private-store/pairs.csv \
  --artifact-map /approved-private-store/artifact-map.json \
  --seal /approved-private-store/seal.json \
  --ground-truth-bundle /approved-private-store/ground-truth.bundle \
  --results /approved-private-store/scored-results.json \
  --output /approved-private-store/reports/aggregate-report-001.json
```

The output directory must already exist. The evaluator refuses to overwrite an existing report and creates a new report with mode `0600`.

Do not use `npm run evaluate:receipt-scanner` for private acceptance data. That legacy synthetic-fixture harness reads its tracked `manifest.json` and overwrites tracked `results.json` and `REPORT.md`.

### Artifact map

`artifact-map.json` is private because it contains local absolute paths. It must use this exact shape:

```json
{
  "schema_version": "finsight-receipt-artifact-map-v1",
  "run_plan": {
    "purpose": "CAPSTONE_DEMO",
    "provider": "LOCAL_TESSERACT",
    "extractor_version_sha256": "[64 LOWERCASE HEX CHARACTERS]",
    "planned_review_end_at_utc": "[ISO 8601 UTC TIMESTAMP]",
    "declared_hardware_sha256": "[64 LOWERCASE HEX CHARACTERS]",
    "cold_or_warm": "COLD"
  },
  "independent_trials": {
    "captures": [
      {
        "capture_attempt_id": "[OPAQUE CAPTURE ATTEMPT ID]",
        "trial_id": "[OPAQUE PREDECLARED TRIAL ID]"
      }
    ],
    "receipts": [
      {
        "sample_id": "[OPAQUE SAMPLE ID]",
        "trial_id": "[OPAQUE PREDECLARED TRIAL ID]"
      }
    ]
  },
  "artifacts": [
    {
      "sample_id": "[OPAQUE SAMPLE ID]",
      "source_path": "/approved-private-store/source-file",
      "ground_truth_path": "/approved-private-store/ground-truth-file",
      "ground_truth_page_count": 1,
      "applicable_fields": ["vendor", "date", "currency_code", "total"],
      "handwritten_fields": [],
      "metric_families": [
        "CAPTURE_DETECTION_LATENCY",
        "CAPTURE_LIVE_GUIDANCE_LATENCY",
        "NORMALIZED_CORNER_ERROR",
        "LINE_ITEMS",
        "MANUAL_CORRECTIONS",
        "LOCAL_RESULT_LATENCY",
        "PROCESSED_COMPOSITE"
      ],
      "metric_denominators": {
        "line_items": {
          "ground_truth_items": 0,
          "quantity_applicable": 0,
          "unit_price_applicable": 0,
          "line_total_applicable": 0
        },
        "manual_corrections": {
          "reviewed_fields": 4,
          "reviewed_items": 0
        },
        "processed_composite": {
          "scored_financial_fields": 4
        }
      }
    }
  ]
}
```

- [ ] Include exactly one entry for each eligible manifest row and no extra entries.
- [ ] Commit the exact run context with hashes, not raw extractor-version or hardware text.
- [ ] Bind every eligible capture attempt and primary receipt to one distinct independent-trial ID before results are opened.
- [ ] Record field applicability, handwritten fields, page counts, metric families, ground-truth denominators, and known-truncation truth before results are opened.
- [ ] For every single-artifact `LONG` primary, seal `long_reconstruction.acquisition_frame_count` at 2 or more. For page or segment groups, use at least two rows with one-based contiguous `page_number` values. A `LONG` condition or guided-mode name alone is insufficient.
- [ ] Use the complete policy-derived metric frame. Do not omit a difficult receipt from a family. Every primary receipt carries line-item, correction, and processed-composite blocks; cohort and page facts determine the handwriting, long-reconstruction, and local-latency blocks.
- [ ] Keep source and ground-truth files outside the repository, including when paths use symlinks.
- [ ] Match each file's bytes to the row's lowercase SHA-256.
- [ ] Keep opaque storage references in the intake CSV. Do not replace them with these local paths.

The validator proves that these declarations were sealed before results and that scored observations match them. It does not independently infer field applicability or denominator truth from private ground-truth content. The two custodians must reconcile those declarations against the source and ground truth before sealing.

A primary whose sealed metric frame includes `LONG_RECONSTRUCTION` must include this denominator block:

```json
{
  "long_reconstruction": {
    "ground_truth_lines": 120,
    "known_truncated": false,
    "acquisition_frame_count": 3
  }
}
```

`acquisition_frame_count` is the sealed number of source frames used to form the complete receipt. It must be at least 2. A genuinely ordered page or segment set also needs at least two logical rows sharing its opaque group ID with contiguous `page_number` values beginning at 1.

The trial map proves predeclaration and exact result binding, not physical independence. The operator must execute each named trial independently under the declared hardware and cold/warm condition.

### Seal

`seal.json` must use this exact shape:

```json
{
  "schema_version": "finsight-receipt-evaluation-seal-v1",
  "policy_id": "finsight-core-evidence-gates-v1",
  "policy_sha256": "[64 LOWERCASE HEX CHARACTERS]",
  "manifest_sha256": "[64 LOWERCASE HEX CHARACTERS]",
  "pair_labels_sha256": "[64 LOWERCASE HEX CHARACTERS]",
  "artifact_map_sha256": "[64 LOWERCASE HEX CHARACTERS]",
  "ground_truth_bundle_sha256": "[64 LOWERCASE HEX CHARACTERS]",
  "sealed_at_utc": "[ISO 8601 UTC TIMESTAMP]"
}
```

- [ ] Hash the exact bytes of every file, including final line endings.
- [ ] Record `sealed_at_utc` before `results_opened_at_utc`.
- [ ] Generate the aggregate report no earlier than `results_opened_at_utc` and no later than the sealed `planned_review_end_at_utc`.
- [ ] Ensure every receipt ground-truth seal and eligible pair review predates the benchmark seal.
- [ ] Start a new seal and output filename after any manifest, label, path-map, or ground-truth change.

### Scored results

`scored-results.json` contains opaque IDs and scored counts, but no receipt text, vendor value, amount, image path, URL, or storage reference.

```json
{
  "schema_version": "finsight-receipt-scored-results-v1",
  "policy_id": "finsight-core-evidence-gates-v1",
  "run": {
    "purpose": "CAPSTONE_DEMO",
    "provider": "LOCAL_TESSERACT",
    "extractor_version_sha256": "[64 LOWERCASE HEX CHARACTERS]",
    "results_opened_at_utc": "[ISO 8601 UTC TIMESTAMP]",
    "planned_review_end_at_utc": "[ISO 8601 UTC TIMESTAMP]",
    "declared_hardware_sha256": "[64 LOWERCASE HEX CHARACTERS]",
    "cold_or_warm": "COLD"
  }
}
```

The example above is a valid no-evidence result and produces `NOT_MEASURED` metric families. Add `captures`, `receipts`, or `pair_predictions` only when the collection is complete.

One report accepts one provider, extractor-version hash, declared-hardware hash, and `COLD` or `WARM` condition. Every run field except the result-open timestamp must match the sealed artifact-map run plan. Produce separate sealed reports for other contexts.

If a result collection is present, it must cover every applicable eligible unit exactly once. Omit a collection to report it as `NOT_MEASURED`. An empty or partial supplied collection is rejected when eligible units exist.

Each capture observation requires:

- `capture_attempt_id`, unique `trial_id`, `actual_document_count`, and `likelihood_outcome`;
- latency fields required by the sealed capture frame;
- one `corner_errors` entry per sealed primary receipt in the capture, keyed by opaque `sample_id`.

Corner intervals resample distinct sealed receipt IDs. Multi-receipt captures retain one corner observation per primary receipt, so a flat trial bootstrap cannot replace the required cluster unit.

The evaluator anchors capture gates on eligible `PRIMARY_RECEIPT` and `NON_RECEIPT` rows. It keeps support rows within their primary capture but excludes `RECAPTURE_ROBUSTNESS` and `DERIVED_NOT_COUNTED` rows from ordinary capstone capture metrics. A recapture may establish a sealed duplicate-pair relationship, but policy v1 has no predeclared robustness trial contract. Recapture-only metric families are therefore rejected, and recapture robustness remains `NOT_MEASURED` until a versioned contract defines its frame and thresholds.

Each receipt observation requires:

- `sample_id`, the exact predeclared `trial_id`, `status`, `page_count`, and exactly one score for each v1 field;
- every text, item, reconstruction, correction, one-page local latency, and processed-composite block required by the sealed metric frame.

The v1 fields are `vendor`, `invoice_number`, `date`, `time`, `currency_code`, `subtotal`, `tax`, `discount`, `total`, and `payment_method`. A field score has:

- `field`, `applicable`, `exact_match`, `confidence_band`, `value_state`, `routed_to_review`, and `handwritten`, all checked against sealed applicability;
- `absolute_error_minor` when an incorrect total has a numeric `PRESENT` prediction. Do not invent numeric error for a missing, conflicting, failed, timed-out, or absent prediction.

`FAILED`, `TIMED_OUT`, and `MISSING` receipt outcomes remain in the complete result frame. Every sealed-applicable field is scored missing and incorrect, critical applicable fields route to review, and the report gives success, failure, timeout, and missing rates separately.

Each pair prediction requires `pair_id` and `predicted_duplicate`.

### Cloud-result guard

The v1 runner accepts `LOCAL_TESSERACT` only. It rejects every other provider because this contract cannot prove the policy-required provider tier, region, provider version, input transform, page-unit cap, or provider-data lifecycle. There is no cloud override flag. The only cloud consent identifier accepted in this version of the manifest validator is the tier-specific `AZURE_DOCUMENT_INTELLIGENCE_F0`; that consent declaration still does not authorize a cloud result. Azure F0, PaddleOCR, Veryfi, and other provider results need a versioned sealed evidence contract before this evaluator can accept them.

## What the evaluator enforces

- [ ] Frozen policy and normative artifact hashes match.
- [ ] Intake and pair CSV headers match the frozen ordered schemas exactly.
- [ ] Controlled values, timestamps, opaque references, and eligibility flags are valid.
- [ ] Eligible use, retention, redaction, consent, and cloud-provider scope cover the declared run.
- [ ] Reviewer pairs are structurally distinct and do not declare common model identities.
- [ ] Source and ground-truth bytes match each eligible manifest row.
- [ ] One eligible primary row exists per receipt ID.
- [ ] Primary cohort tags match facts aggregated across the eligible logical receipt, including support rows and sealed handwriting applicability.
- [ ] Receipt, cohort, non-receipt, vendor-template, and pair counts are calculated over the policy counting units.
- [ ] Pair order is canonical, pair rows are unique, and eligible pairs reference eligible samples.
- [ ] Duplicate pair labels bind samples with the same non-`NOT_APPLICABLE` receipt ID; non-duplicate labels bind distinct receipt IDs.
- [ ] Supplied result collections match the sealed full frame, denominators, page counts, and applicability.
- [ ] Provider failure and timeout rows cannot disappear from field denominators.
- [ ] Receipt, field, cohort, and confidence metrics use eligible real-receipt primaries; synthetic primaries remain validation fixtures and cannot dilute a real failure.
- [ ] Incorrect numeric totals require absolute-error evidence; missing and failed totals forbid fabricated numeric error.
- [ ] Existing output, repository-contained output, relative private paths, and symlink escapes into the repository are rejected.

Structural validation errors produce no report. `CAPSTONE_DEMO` corpus, cohort, non-receipt, pair, and vendor-share floors are checked before scored-result bytes are read; a floor miss stops without a report. Use a separately sealed `LOCAL_ENGINEERING` run when the purpose is to diagnose and report an under-floor corpus. Accuracy shortfalls in a complete, structurally valid run remain failed report gates.

## Statistical output

- Binary field, sample, and pair proportions use the two-sided 95% Wilson score interval without continuity correction.
- Text, line, item, correction, corner, latency, and processed-composite metrics use the policy's seeded percentile bootstrap where the scored contract has the required counts. Corner metrics resample distinct receipt clusters, not flat capture trials.
- Bootstrap output uses 10,000 resamples and seed `20260913` from policy v1.
- Paired processed-composite gain retains negative receipt-level deltas.
- Seeded bootstrap inputs are sorted by sealed opaque unit IDs, so reordering scored-result arrays does not change confidence intervals.
- Every measured metric records its numerator or trial count, denominator, point estimate, interval, threshold when applicable, and gate result.
- Missing input families remain `NOT_MEASURED`. The runner does not infer a pass.
- Capstone pair floors of 10 duplicates and 20 non-duplicates determine the capstone corpus gate. Promotion floors of 100 and 200 are reported separately and cannot make a valid capstone corpus fail.
- Provider-promotion support of 100 eligible real receipts and 30 receipts per affected cohort is reported separately from the 30-receipt capstone floor. The current contract reports every cohort's support and does not infer which cohorts are affected.
- The report exposes separate capstone-corpus, provider-promotion, and duplicate-promotion decisions and blocker lists. Corpus support alone cannot approve a provider or duplicate promotion. Cloud lifecycle evidence, raw-versus-normalized scoring, the provider cohort macro-average, provider selection review, and duplicate owner review remain unavailable in v1.
- `CAPSTONE_DEMO` receipt and capture gates use consented-owner primaries only; public-licensed and synthetic receipt captures cannot dilute them. Eligible non-receipts remain in their frozen frame. Mixed-source capture-level outcomes are `NOT_MEASURED`; attributable per-receipt corner observations remain separate.
- Confidence bands below their support floor remain uncalibrated. Missing support or monotonicity evidence keeps the metric result incomplete.

Policy v1 requires more cohort and capture-mode splits than the current scored-results contract represents for every metric family. Field exact match includes both splits. Other incomplete split families appear as `NOT_MEASURED` and remain a blocker. Do not describe this report as complete frozen-policy evidence until a versioned contract adds those splits.

The aggregate report omits sample IDs, receipt text, field values, local paths, storage references, raw extractor or hardware labels, and individual source or ground-truth hashes. It includes aggregate counts, controlled run dimensions, run-context hashes, seal hashes, metric results, and named evidence gaps.

## Physical Android acceptance

No physical run is eligible yet while policy v1 has a null device-specific peak-PSS ceiling.

- [ ] Record the minimum supported API/RAM-class target: model, OS/API, camera output, RAM, app memory class, build type, and thermal starting state.
- [ ] Record the mainstream target with the same fields.
- [ ] Freeze a numeric peak-PSS ceiling for each target in a versioned device-specific policy amendment before the first run.
- [ ] Run 10 standard sessions per target.
- [ ] Run 5 long sessions per target, each at or below 90 seconds.
- [ ] Run 5 background/resume cycles per target.
- [ ] Exercise permission denial and revocation, process recreation, low memory, thermal pressure, torch, rotation/crop, cancellation, and recovery.
- [ ] Exercise TalkBack and large text.
- [ ] Record no OOM, ANR, or thermal shutdown.
- [ ] Verify full-resolution source, rectified, enhanced, composite labels, page order, batch boundaries, and readable evidence review.

Do not replace physical-device evidence with emulator, render-test, or instrumentation-APK build results.

## Deployed private-storage and purge acceptance

- [ ] Classify the hosted project as synthetic/demo-only or real-owner before any further hosted action.
- [ ] Obtain explicit authorization before applying migrations or changing hosted configuration.
- [ ] Retrieve source, rectified, and enhanced evidence as the owning active business.
- [ ] Deny each evidence variant to another business profile.
- [ ] Verify signed links expire at ten minutes and refresh only after a new authorized request.
- [ ] Delete an unfinished scan and confirm source, derived, correction, category, and duplicate artifacts are removed after purge completion.
- [ ] Detach confirmed evidence and confirm the financial record remains while stored evidence is removed.
- [ ] Inspect private storage after the worker reports completion. A database status alone is insufficient.
- [ ] Verify purge retry, lease recovery, checkpoint continuation, and terminal failure behavior.

Do not roll back the additive hosted migration recorded in [HOSTED-MIGRATION-INCIDENT.md](./HOSTED-MIGRATION-INCIDENT.md). Do not apply the remaining Phase 2 migrations without explicit approval.

## Real-receipt corpus acceptance

- [ ] Collect at least 30 distinct consented owner receipts.
- [ ] Include at least 5 receipts in every frozen cohort; tags may overlap only when each predicate is true.
- [ ] Include at least 10 eligible non-receipts.
- [ ] Include at least 10 known duplicate pairs and 20 known non-duplicate pairs.
- [ ] Keep each vendor template at or below 20% of distinct eligible receipt IDs.
- [ ] Have two custodians independently transcribe and reconcile ground truth before sealing.
- [ ] Record consent version, permitted uses, provider list, retention end, and private references without receipt content in the manifest.
- [ ] Run local Tesseract first. Keep external OCR disabled unless the separate cloud benchmark gates pass.
- [ ] Review the aggregate report and every `NOT_MEASURED`, failed, or uncalibrated entry.

Thirty receipts support a capstone demonstration and transparent point estimates. They do not support a production accuracy claim.

## Repository verification

```bash
cd backend
npm run typecheck:receipt-scanner:policy-v1
npm run test:receipt-scanner:policy-v1
npx oxlint tests/receipt-scanner-evaluation/policy-v1-*.ts \
  tests/receipt-scanner-evaluation/run-policy-v1-evaluation.ts
```

- [ ] Focused type-check passes.
- [ ] Focused tests pass.
- [ ] Focused lint passes.
- [ ] The legacy tracked `manifest.json`, `results.json`, and `REPORT.md` remain unchanged.
- [ ] No populated corpus, private path map, source image, ground truth, or scored private result appears in Git status.

## Exit decision

The four P1 findings are resolved and locally verified. Phase 2 remains open until required P2 decisions are recorded, physical-device evidence passes, deployed private-storage and purge checks pass, and the consented corpus report contains no failed mandatory gate. Any unavailable evidence remains named. A capstone pass must still state that it is not a production accuracy claim.
