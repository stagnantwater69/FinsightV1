# Phase 2 receipt workflow implementation evidence

**Branch:** `feat/phase2-scanner-acceptance`
**Prepared:** 13 September 2026
**Release status:** Code-complete candidate; physical-device, consented-corpus, and deployed private-storage checks remain open

## Outcome

Phase 2 turns a receipt capture into a recoverable, owner-reviewed workflow:

1. The original image is stored before OCR begins.
2. OCR and categorization run through the existing local-first processing path.
3. Failed processing can be retried from stored bytes without another upload.
4. The owner reviews the source image, extracted fields, items, totals, categories, and possible duplicates.
5. Edits use a scan revision so a stale screen cannot overwrite newer data.
6. Confirmation writes the financial records atomically.
7. Unfinished scans can be deleted; confirmed scans retain their financial audit while their receipt evidence can be detached asynchronously.

For a multi-receipt selection, every child must receive a server-side scan ID before the first review screen opens. Uploads are sequential and idempotent. Once review starts, a browser reload or mobile process restart can recover each accepted child from receipt history.

## Delivered scope

- Durable, ordered receipt-capture batches with explicit `CANCELLED` handling.
- Active receipt history, stored-result resume, whole-scan retry, and unconfirmed-scan deletion.
- Private original and derived page evidence with short-lived signed-link retrieval.
- Source-region evidence for extracted fields.
- Revision-guarded item edit, item removal, and receipt confirmation.
- Locked duplicate recheck at confirmation, paginated candidate review, explicit “save anyway” acknowledgement, and stable candidate-set hashes.
- Exact-image matching based only on canonical ordered original bytes; upload/idempotency metadata uses a separate hash.
- A shared business-profile transaction gate for receipt, manual-entry, and CSV duplicate writes.
- Durable staged evidence purge with retry, leases, checkpoints, and expiry cleanup for terminal purge results.
- Full-resolution Android Standard capture, source-coordinate geometry, bounded capture/read waits, Long/manual modes, interruption recovery, and scanner-cache cleanup.
- Web and mobile review flows that preserve owner edits through recoverable failures.

FinSight still has one human role in this scope: the business owner. Phase 2 does not add staff, bookkeeper, or multi-role workflows. Business-profile scoping remains in place so an owner's businesses cannot read or mutate one another's receipt data.

## Technology and cost posture

The default OCR path remains Tesseract with packaged English language data. It runs locally in the FinSight worker image, works without an OCR-provider network call, and has no per-receipt fee. Optional paid OCR-provider dispatch remains disabled behind consent, budget, and kill-switch controls. Phase 2 does not require a paid provider.

## Database evidence

All database-capable verification commands pin both `DATABASE_URL` and `DIRECT_URL` to a disposable PostgreSQL 16 database.

- Fresh replay: 43 migrations applied successfully.
- Prisma migration status: current.
- Migrated database to `schema.prisma` diff: no difference detected.
- `sourceImageHash` constraint probe: accepts `NULL` and 64-character lowercase hexadecimal values; rejects uppercase and 63-character values.

Phase 2 migrations and frozen SHA-256 values:

| Migration | SHA-256 |
|---|---|
| `20260913100918_receipt_capture_batches_and_scan_revision` | `8e03ef8f26dba6af0316d4a6488468afecf4a4bb25a972989a8e7a5dda4f782b` |
| `20260913192200_receipt_capture_batch_cancelled_status` | `24b9972b0fa9a4a49f537e946986f2f9cdc43d35bafe0530a6716fa864479281` |
| `20260913194745_receipt_scan_source_image_hash` | `d33826adc8864f0d682fe03bc3cafeb099b53d51e353e41296c0d3343a4db4d6` |

## Automated verification

The final commit and hosted CI run are recorded in the pull request. Local coordinated-gate evidence:

- Backend focused acceptance: 26/26 tests passed.
- Backend affected integration set: 184/184 tests passed.
- Backend complete suite: 150 files, 2,131 tests passed and 1 skipped.
- Web unit/component suite: 83 files, 726 tests passed.
- Web Chromium end-to-end suite: 18/18 tests passed.
- Web type-check, lint, production build, and bundle budget passed; largest JavaScript chunk was 344.1 KiB.
- Mobile on Node 22: 97 files, 1,053 tests passed; type-check and lint passed with no errors.
- Android Kotlin compilation and instrumentation APK assembly passed (109 tasks). No Android device was attached, so the instrumentation APK was not executed.
- ML worker: 13/13 tests passed and `pip check` reported no dependency conflicts.
- Compose parsing, nginx syntax, upload-envelope validation, orphan cleanup, API signal forwarding, and worker-readiness drills passed.
- Production API and worker image builds, image command/entrypoint checks, worker health, network-disabled packaged OCR, missing-language refusal, and API-to-PostgreSQL readiness passed.
- The network-disabled OCR gate invokes Node directly, so the embedded script is executed rather than being detached from standard input by the worker supervisor.
- Production-image assertions confirm that the Prisma CLI, `@prisma/config`, and `deepmerge-ts` are absent while the generated Prisma query engine remains present. The API image is 162,527,162 bytes after pruning the optional CLI peer.

The pruned production dependency tree no longer contains the high-advisory Prisma CLI chain. Three moderate `qs` findings remain through Express 4 and `body-parser`; these stay visible in the non-blocking audit and are not described as a clean security audit. Updating that chain is a separate compatibility task.

## Incident disclosure

During migration validation, Prisma loaded the configured hosted `DIRECT_URL` even though `DATABASE_URL` pointed to a disposable database. The first additive Phase 2 migration was consequently applied to the hosted Supabase database without authorization. Hosted access stopped immediately. No rollback or compensating write was attempted because the migration is additive and a rollback would be destructive.

Only `20260913100918_receipt_capture_batches_and_scan_revision` reached the hosted database. The later `CANCELLED` and source-image-hash migrations were validated only against disposable local PostgreSQL instances. See [HOSTED-MIGRATION-INCIDENT.md](./HOSTED-MIGRATION-INCIDENT.md) for the preserved artifact hash, impact review, and containment record.

The test harness now gives explicitly supplied environment variables precedence over checked-in local defaults. This does not replace reviewed deployment controls: later migrations must still be applied through the authorized deployment workflow.

## Open release acceptance

These checks require hardware, consented data, or deployed credentials and are not represented as automated passes:

- Standard, Long, batch, permission, lifecycle, rotation/crop, low-memory, thermal, TalkBack, and large-text journeys on representative Android devices.
- Authenticated end-to-end retrieval from the deployed private receipt bucket, including signed-link expiry and refresh.
- OCR, field, line-item, duplicate, latency, and correction-rate thresholds on the consented real-receipt corpus.
- Manual inspection that deleted evidence is absent from private storage after the purge worker completes.

Native iOS VisionKit, trained handwriting models, local embeddings, multiple paid-provider failover, staff/bookkeeper roles, and configurable production retention/redaction remain post-MVP work.
