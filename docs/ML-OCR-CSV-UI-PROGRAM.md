# ML / OCR / CSV / UI Improvement Program

**Status:** in execution · **Baseline gate (start of program):** backend 929 tests / 58 files, web 200 / 21, mobile 208 / 22, typechecks + builds green, 0 pending migrations.
**Source prompt:** `docs/ML-OCR-CSV-UI-IMPROVEMENT-PROMPT.md`. Read-only audits of all four areas were completed first; file:line evidence lives in the phase reports below.

## Architecture decision records

### ADR-1 — Python boundary for Isolation Forest

**Decision.** A long-lived, stdlib-only HTTP sidecar (`ml/worker/server.py`, no FastAPI/Flask — two endpoints, ~zero dependency surface) speaking a versioned JSON contract (`if-contract-v1`). The TypeScript side keeps all database reads and ownership scoping; only a bounded, tenant-free feature matrix crosses the boundary. The Node backend never spawns Python per transaction — scoring happens batch-wise inside the existing durable `PROFILE_REFRESH` analysis jobs, one HTTP call per profile refresh.

**Safeguards.** 5s request timeout, 1 MB request cap and 5,000-row matrix cap (both sides), circuit breaker in the TS client (3 consecutive failures → open for 60s), health endpoint, structured one-line logs. If the sidecar is down, misbehaving, or the flag is off, the job completes on the existing deterministic detectors — the ML path can only ever add findings, never block analysis, record creation, or imports.

**Rejected.** Spawn-per-job child process (first `child_process` in production, lease-budget interference); pure-TS forest (re-implementing sklearn poorly defeats the evaluation point).

### ADR-2 — Model lifecycle: artifact-free v1

**Decision.** No persisted model artifacts and therefore **no pickle, ever** — the fit happens per scoring pass on the profile's bounded history (365 days / ≤2,000 rows) with a fixed seed, inside the sidecar call. Versioning is carried per finding: `modelVersion` (`iforest-v1` + pinned sklearn), `featureVersion` (`if-features-v1`), training window and row count in finding metadata. Reproducibility = same inputs + same pins + same seed.

Contamination is not trusted as a product decision: the forest runs with `contamination="auto"` and the **alert budget** is enforced in TypeScript — at most 2 shadow findings per 100 scored records per profile pass, minimum normalized score 0.70, ranked by score. Thresholds move only on reviewed-label evidence (the A1 harness computes them).

**Revisit when** fit latency on real profiles is measured to matter; then artifact caching with hash verification per the prompt.

### ADR-3 — CSV import state machine

**Decision.** `CSVImportBatch` gains what `ReceiptScan` already proved out: a `processingStatus` enum (PENDING / PROCESSING / COMPLETE / FAILED) **separate** from the owner-facing review status, a unique client `idempotencyKey`, `fileHash`, persisted row counts + failure stage, parser/mapping metadata, and worker columns (attempts, heartbeat, lastError). Confirmation becomes: create batch row (PENDING, transactional) → upload file to Storage (compensating delete on later failure + orphan sweep keyed on PENDING age) → validate → insert in bounded transactional chunks with a persisted checkpoint → COMPLETE. A replayed idempotency key returns the same logical import at whatever stage it reached — never a second import. Dates are parsed by an explicit, timezone-independent calendar parser (the `new Date(string)` call at `csvImport.service.ts:284` is a real UTC+8 off-by-one-day bug today); ambiguous day/month files surface the detected convention for owner confirmation. `ExpenseCategory` gets the missing `@@unique([businessProfileId, name])` and race-safe upsert. One `PROFILE_REFRESH` analysis job is enqueued per committed import (coalesced), on top of the existing per-row transaction jobs.

**Kept.** The 30,000-row cap, the preview/mapping/correction UX, duplicate flag-don't-block policy, and the synchronous fast path for small files (large files move off the request onto the existing 5-second worker tick with a status-polling endpoint).

### ADR-4 — User-facing finding contract

**Decision.** Every owner-visible finding presents: a plain-language title, 1–3 reasons, the comparison baseline, source + time, and a **confidence band** (never a raw model score); detector name, versions, raw scores and feature deviations live in an expandable audit section. ML findings get their own `ML_OUTLIER` type and a new **`SHADOW` status** — the audit showed `OPEN` findings are immediately rendered by both clients *and* injected into Ask FinSight context, so shadow mode must be a storage-level state, not a severity trick. `SHADOW` findings are excluded from `listFindings`, summaries, notifications, and AI context; they are visible only through the evaluation endpoint. Promotion out of shadow is a separate, deliberate release step gated on measured precision.

Calibrated receipt-confidence bands ("Looks clear" / "Check a few fields" / "Review carefully") replace the three mutually inconsistent raw-percentage cutoffs (75 routing / 80·60 web / 75 item) with one shared mapping defined next to the calibration data that justifies it.

## Phased plan (rollback point per phase)

| Phase | Scope | Owner | Rollback | Status |
|---|---|---|---|---|
| 0 | Audits, baseline gate, ADRs, worktree checkpoint commit | orchestrator | n/a (read-only + checkpoint) | **done** |
| 1 | **A** — feature contract, sidecar, shadow detector, flag `ANOMALY_ISOLATION_FOREST_ENABLED` (default false), A1 experiment harness + versioned report | ai-ocr-analytics + database | flag off; schema changes additive (enum values) | **done** |
| 2 | **C** — import state machine, idempotent confirm, chunked inserts, calendar date parsing, category uniqueness, storage compensation, cell-limit validation, batch-coalesced analysis | database + backend-api | additive migration; `git revert` of the service change restores the old path | **done** |
| 3 | **B** — provider-enforced response schema + Zod at the boundary, per-field evidence + machine-readable warning codes, provider/model/prompt/schema version recording, verifier gate for high-risk fields, ambiguous-date flag | ai-ocr-analytics | prompt/schema version recorded per scan; revert restores prior extractor | **done** |
| 4 | **D** — unified web review queue with filters + audit expansion + Ask-FinSight "explain this flag"; shared confidence bands both platforms; honest staged progress; mobile CSV three-step parity (mapping, row review, corrections, vendor); crop-handle tap targets | web-frontend + mobile | UI-only; revert per surface | **done** |
| 5 | QA/security sweep (ownership isolation, multipart/HTTP boundaries, failure injection), runbook/docs, final full gates | qa-security + devops-release | n/a | **done** |

## Final gate (all four projects)

| Project | Result |
|---|---|
| Backend | 1,032 passed, 1 env-skip (66 files) · typecheck · build · `prisma validate` · 3 migrations apply clean |
| Web | 254 passed (26 files) · typecheck · lint · build |
| Mobile | 279 passed (25 files) · typecheck · lint · typography tokens clean |
| ML worker | 9 passed · plus the TS↔Python wire contract test from the backend suite |
| **Total** | **1,574 passing** (baseline 1,337, **+237**) |

A defect the program found and fixed on the way: web's CSV row preview still
ran the banned `new Date(rawDate)`, so it disagreed with the server about
which rows were broken — flagging valid rows and passing invalid ones. Web,
mobile and the server now share one calendar parser, and
`mobile/tests/webParity.test.ts` imports web's actual lib so the two clients
cannot drift apart again.

## Backend result (phases 1–3, 5-backend)

Backend suite **929 → 1,032 passing** (+103), 1 environment-skip (the ML wire
contract test, which skips visibly when `ml/.venv` is absent). Typecheck,
production build and `prisma validate` green; 3 additive migrations apply to a
clean database.

New endpoints/flags shipped OFF or backward-compatible:
`ANOMALY_ISOLATION_FOREST_ENABLED=false`, `ML_WORKER_URL`,
`GET /records/csv-imports/batches/:id/status`, confirm's optional
`idempotencyKey`/`dateFormat` (see the Phase-4 shim note in
`csvImport.controller.ts`), and rate limits on the two CSV endpoints that
previously had none.

## Explicitly deferred (not silently skipped)

- **Real-receipt corpus expansion (B1)** — requires consented, redacted receipts from real owners; not fabricatable by an agent. The benchmark keeps synthetic/degraded/real segments separate (3 real photos today) and every accuracy claim states corpus composition.
- **A1 on real owner labels** — no production feedback data exists in this environment. The experiment harness runs on a labeled synthetic corpus and is honest about it; the same harness re-runs unchanged once real shadow data accumulates. This is exactly why the detector ships shadow-only.
- **Physical-device camera verification** — manual, per the project's own non-negotiable; called out in the final report.
- **Mobile dark theme** — D4 conditions dark appearance on semantic tokens that don't exist yet; out of scope.
