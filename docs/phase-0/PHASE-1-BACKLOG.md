# FinSight Phase 1 implementation backlog

**Prepared:** 13 September 2026

**Scope:** worker, upload, cost, consent, and local OCR guardrails

**Human user scope:** one Small Business Owner account; no invitations, collaboration, staff, bookkeeper, or administrator surface

Phase 1 implementation may start from runtime checkpoint `20d011ec8c51fb026abb1d29b53c4f8a196227b7`. The repository and migration closure ticket is complete. Real-data rollout still waits for the evidence and account-security closure tickets.

## Phase 0 implementation closure and release gates

### P0-CLOSE-01: settle the repository and migration baseline

- **Priority:** P1
- **Owners:** orchestrator, then database
- **Status:** COMPLETE on 13 September 2026
- **Blocked by:** nothing
- **Work:** decide which existing changes belong in the candidate, preserve them in coherent commits or another approved checkpoint, then compare the local Prisma migration ledger with the hosted `_prisma_migrations` ledger. Preserve the exact hosted-applied receipt-upload-idempotency migration; separately locate and explain the authoritative historical receipt-field-corrections artifact.
- **Acceptance:** the working tree is intentionally checkpointed; all 39 present migration files are accounted for; the hosted-applied `20260910152035_receipt_upload_idempotency` file is tracked with its current matching checksum; the `20260804140000_receipt_field_corrections` checksum difference has an evidence-backed resolution; `migrate:validate` passes from a fresh disposable database; hosted status is read-only verified; authoritative deployed migration bytes are unchanged, and any local history correction is byte-exact, evidence-backed, and documented.
- **Evidence:** runtime commit `20d011e`; exact receipt-field-corrections blob `80d438a71a1a64def5ba2b4e54cb2015595e4612`; 39 local and successful hosted migrations with zero checksum mismatches; fresh full-chain replay and 1,983 backend tests passed with one expected skip; hosted status, zero schema drift, RLS, and effective client-privilege checks passed read-only. See `P0-CLOSE-01-EVIDENCE.md`.

### P0-CLOSE-02: supply the missing real-world evidence inputs

- **Priority:** P1 release gate
- **Owners:** business owner and QA
- **Blocked by:** consented receipts and two physical Android targets
- **Work:** copy the header-only receipt-intake and pair-label examples to approved encrypted storage outside Git, collect the minimum corpus, independently verify and seal ground truth before results are opened, record the two device specifications, set a numeric peak-PSS ceiling for each device before testing, and execute the pre-change physical baseline checklist.
- **Acceptance:** at least 30 unique consented real receipts meet the frozen cohort mix; at least 10 non-receipts, 10 duplicate pairs, and 20 non-duplicate pairs are labeled; both device rows, pre-run PSS ceilings, and baseline evidence are complete; no image, populated manifest, pair label, consent reference, private storage reference, ground truth, or receipt text is committed to Git.
- **Implementation effect:** this gate does not block local Phase 1 code. It blocks receipt-accuracy claims and physical-camera release claims.

### P0-CLOSE-03: confirm synthetic-only or real-owner account posture

- **Priority:** P1 release gate
- **Owners:** business owner, qa-security, and devops-release
- **Blocked by:** owner confirmation of the hosted account and data type
- **Work:** record whether the hosted project contains synthetic capstone credentials/data only or a real password-based owner account. Keep Supabase Free only for the synthetic posture. Before real-owner rollout, use Supabase Pro, currently starting at USD 25 per month, or an approved equivalent that satisfies leaked-password protection and backup requirements. For Pro, enable the organization Spend Cap, inventory every excluded usage item and add-on, retain the included compute class, and require explicit owner approval for any paid add-on. For the confirmed private single-owner deployment, provision the owner first and then disable new public signups; do not invent invitation or staff flows.
- **Acceptance:** the account/data classification is recorded; leaked-password protection is enabled for real password-based use; new public signup is disabled after the private owner's account is provisioned; database plus recursive Storage restore evidence exists before production; the Pro Spend Cap and upcoming invoice are verified in the target organization; excluded usage and add-ons are recorded; no unapproved paid add-on exists; no real receipt is sent through a developer free-tier AI path.
- **Implementation effect:** this gate does not block local Phase 1 code. It blocks real-owner deployment and use of real financial data.

## Build order

### P1-DB-01: add consent, cost reservation, and audit storage

- **Priority:** P1
- **Owner:** database
- **Depends on:** P0-CLOSE-01
- **Likely surfaces:** `backend/prisma/schema.prisma`, one additive migration
- **Work:** add business-scoped provider-consent state, atomic monthly provider-unit reservations, safe dispatch audit metadata, and resumable purge state. Store no receipt text, image URL, item payload, or payment data in the audit record. Revoke default public-function execution from `anon` and `authenticated` before any public function is introduced.
- **Acceptance:** concurrent reservations cannot exceed the configured unit cap; all queries require the authenticated owner's active business; RLS and explicit `anon`/`authenticated` revokes cover every new table and sequence; default table, sequence, and function privileges remain deny-all for client roles; foreign keys and cascades support safe backend lifecycle cleanup.
- **Rollback:** leave provider dispatch disabled and revert only the additive application usage after compatibility review. Do not delete an applied migration.

### P1-BE-01: make the dedicated worker the only OCR consumer

- **Priority:** P1
- **Owner:** backend-api
- **Depends on:** P0-CLOSE-01
- **Likely surfaces:** receipt controller, receipt orchestration service, API startup, worker startup
- **Work:** upload and retry must persist or requeue work only. Remove eager `claimAndProcessScan()` execution from the API process. Preserve idempotent status reads and stale-job recovery.
- **Acceptance:** an integration test fails if the API process invokes OCR or a provider; the worker claims each job once under concurrent polling; retries reuse stored private bytes; API restart does not lose a scan.
- **Rollback:** restore the previous enqueue contract only with cloud providers disabled; schema remains additive.

### P1-BE-02: enforce one bounded receipt upload contract

- **Priority:** P1
- **Owner:** backend-api
- **Depends on:** P0-CLOSE-01
- **Likely surfaces:** upload middleware, receipt route/controller, backend storage orchestration
- **Work:** replace the current all-in-memory paired multipart path with bounded temporary-file or streaming ingestion and sequential private upload. Enforce 10 MiB per object, eight logical pages, and 80 MiB total before decode. Clean request-owned temporary data after success, failure, abort, and timeout.
- **Acceptance:** the API enforces object, page, and aggregate limits before OCR; malformed multipart input is bounded; request cleanup is idempotent; no client filename becomes an object path; backend contract tests publish exact byte semantics for the proxy and clients.
- **Rollback:** keep the current endpoint contract while disabling receipt upload if the bounded path cannot be operated safely.

### P1-DB-02: align private Storage bucket restrictions

- **Priority:** P1
- **Owner:** database
- **Depends on:** P1-BE-02
- **Likely surfaces:** Supabase Storage bucket configuration and its verification evidence
- **Work:** set per-object size and MIME restrictions for the private `receipts` and `csv-imports` buckets to match the approved backend contract. Keep both buckets private and do not add direct client object policies.
- **Acceptance:** receipt objects allow only the approved JPEG, PNG, and WEBP types up to 10 MiB each; CSV source objects follow the exact 5 MiB file-body contract; read-only SQL verifies bucket visibility/restrictions and the deny-by-no-policy client posture.
- **Rollback:** keep direct client access denied and disable affected upload routes until the backend and bucket contract agree.

### P1-OPS-01: make local Tesseract genuinely offline

- **Priority:** P1
- **Owner:** devops-release
- **Depends on:** P0-CLOSE-01
- **Likely surfaces:** backend Dockerfile, OCR environment contract, CI smoke test, deployment runbook
- **Work:** copy every configured traineddata file into the production image, pin a checksum, configure a read-only local language-data path, and fail readiness when a configured language is missing.
- **Acceptance:** a clean production worker with outbound network blocked completes a cold English receipt OCR run; the image build verifies the checksum; no runtime download is attempted; local/manual entry remains available when OCR readiness fails.
- **Rollback:** provider calls stay off and receipt OCR reports unavailable rather than reaching an unapproved network source.

### P1-AI-01: produce a local-first rescue decision

- **Priority:** P1
- **Owner:** ai-ocr-analytics
- **Depends on:** P1-BE-01 and P1-OPS-01
- **Likely surfaces:** OCR/extraction services, provider-neutral types, `extractionMetrics`
- **Work:** run Tesseract and deterministic parsing first, then return a versioned `RescueDecision` from missing or conflicting critical fields, handwriting/damage flags, and calibration state. The backend-owned receipt worker consumes that decision. Do not use a raw provider confidence score as a decision.
- **Acceptance:** a clean, validated local result requests no rescue; uncertain output stays reviewable; routing reason and version are recorded without receipt content; backend integration proves that disabled cloud dispatch still completes locally.
- **Rollback:** force local/manual mode with one kill switch.

### P1-AI-02: define a disabled provider-neutral rescue seam

- **Priority:** P1 guardrail
- **Owner:** ai-ocr-analytics
- **Depends on:** P1-DB-01 and P1-AI-01
- **Likely surfaces:** provider-neutral interface, normalized extraction schema, reservation/outcome types
- **Work:** define the adapter boundary and validated normalized result without adding an Azure network client. The seam must require consent, a reserved unit, provider/version/region metadata, timeout outcome, and safe evidence before any implementation can dispatch.
- **Acceptance:** no Phase 1 implementation can make an Azure call; the default limit is zero; contract tests reject a call without current consent/reservation; an invalid provider result cannot overwrite a safer local value.
- **Rollback:** remove the unused seam while local OCR and owner review continue.

### P1-BE-03: enforce provider consent and safe failures

- **Priority:** P1
- **Owner:** backend-api
- **Depends on:** P1-DB-01
- **Likely surfaces:** provider dispatch boundary, error middleware, receipt DTOs, account deletion
- **Work:** expose current consent/revocation state for the active business, require it at the future dispatch boundary, map provider failures to stable public codes, redact provider bodies from stored errors and logs, and extend backend account deletion to remove consent and dispatch metadata.
- **Acceptance:** revoked or missing consent permits zero dispatches; revocation stops future dispatch; account deletion removes consent and dispatch metadata; tests prove raw provider text, receipt text, signed URLs, and card fragments do not enter logs or public errors.
- **Rollback:** cloud dispatch remains disabled.

### P1-BE-04: enforce one fail-closed receipt-provider dispatch gate

- **Priority:** P1
- **Owner:** backend-api
- **Depends on:** P1-DB-01, P1-AI-01, P1-AI-02, and P1-BE-03
- **Likely surfaces:** backend-owned receipt worker orchestration and environment validation
- **Work:** put current Gemini/Veryfi receipt calls and every future adapter behind one server-side gate. An absent enable flag, absent finite limit, missing consent, failed reservation, uncalibrated route, or active kill switch must mean zero dispatches. A configured API key alone must never enable receipt upload to a provider.
- **Acceptance:** tests inject valid provider credentials while the enable flag is absent or false and observe zero calls; an unset unit limit means zero; local OCR and owner review still complete; one kill-switch change stops new dispatches across workers.
- **Rollback:** keep the global gate off.

### P1-WEB-01: adopt the shared upload and consent contracts on web

- **Priority:** P1
- **Owner:** web-frontend
- **Depends on:** P1-BE-02, P1-BE-03, and P1-BE-04
- **Likely surfaces:** web receipt selection/upload and cloud-consent presentation
- **Work:** enforce the published page/object/aggregate limits before upload. Present provider consent only when the backend advertises an available future provider; otherwise keep cloud controls absent and local review unchanged.
- **Acceptance:** boundary fixtures match backend byte semantics; an over-limit selection is preserved for correction rather than uploaded; consent copy names data, purpose, region, retention, and revocation; no client can enable a server-disabled provider.

### P1-MOB-01: adopt the shared upload and consent contracts on mobile

- **Priority:** P1
- **Owner:** mobile
- **Depends on:** P1-BE-02, P1-BE-03, and P1-BE-04
- **Likely surfaces:** mobile receipt selection/upload and cloud-consent presentation
- **Work:** enforce the published page/object/aggregate limits across original and processed evidence before upload. Present the same conditional consent contract as web without changing physical-camera behavior.
- **Acceptance:** boundary fixtures match backend and web; oversized evidence remains available for retake/removal; no provider control appears when the backend disables cloud rescue; automated UI evidence is labeled mocked and physical camera claims remain open.

### P1-OPS-02: align proxy and temporary-storage operations

- **Priority:** P1
- **Owner:** devops-release
- **Depends on:** P1-BE-02
- **Likely surfaces:** nginx, API temporary volume/permissions, cleanup scheduling, CI deployment tests
- **Work:** size nginx for the exact 80 MiB file aggregate plus measured multipart overhead, provide bounded non-public temporary storage, and operate the hourly orphan sweep. Do not fix the mismatch by allowing a 160 MiB in-memory request.
- **Acceptance:** proxy boundary tests agree with backend contract fixtures; temporary paths are non-public and least-privileged; abort/restart/orphan drills reclaim files without touching active uploads.

### P1-OPS-03: operate the kill switch and cleanup path

- **Priority:** P1
- **Owner:** devops-release
- **Depends on:** P1-DB-01, P1-DB-02, P1-BE-01, P1-BE-02, P1-BE-04, P1-OPS-01, P1-OPS-02, P1-AI-01, P1-AI-02, and P1-BE-03
- **Likely surfaces:** environment examples, worker health, deployment runbook, monitoring configuration
- **Work:** document and test provider-disable, budget exhaustion, orphan cleanup, queue recovery, secret rotation, and safe rollback drills. Keep provider paid overage disabled. For a Pro target, add an operator check for organization Spend Cap state, excluded usage/add-ons, approved compute class, and upcoming invoice.
- **Acceptance:** operators can stop cloud dispatch without stopping local OCR; readiness distinguishes API, worker, database, Storage, language data, and optional provider state; a drill records bounded cleanup and safe counts without financial content; release evidence verifies the Pro Spend Cap is on and no paid add-on exists without explicit owner approval.

### P1-QA-01: prove guardrails and ownership isolation

- **Priority:** P0 for isolation, P1 for the remaining Phase 1 gates
- **Owner:** qa-security
- **Depends on:** P1-DB-01, P1-DB-02, P1-BE-01, P1-BE-02, P1-BE-03, P1-BE-04, P1-OPS-01, P1-OPS-02, P1-OPS-03, P1-AI-01, P1-AI-02, P1-WEB-01, and P1-MOB-01
- **Work:** add unit, contract, integration, adversarial multipart, process-boundary, provider-timeout, budget-race, consent, deletion, and tenant-tampering tests.
- **Acceptance:** no cross-profile scan, image, signed URL, consent, budget reservation, or audit event is observable; API-only test processes cannot perform OCR; budget concurrency cannot overspend; the full backend, web, and mobile gates pass; mocked provider and camera tests are labeled as such.

## Phase 1 completion gate

Phase 1 is complete only when all of the following are evidenced:

- the API process never performs OCR or provider work;
- cold local OCR passes with outbound network blocked and checksummed local language data;
- paired receipt uploads cannot exceed the single enforced 80 MiB aggregate contract;
- cloud receipt OCR defaults to off, Phase 1 contains no Azure network adapter, and the future F0 benchmark policy remains capped at 100 page units;
- configured Gemini or Veryfi credentials alone cannot enable receipt dispatch, and an unset provider limit means zero;
- the provider-neutral contract cannot dispatch without current owner consent and an atomic reserved unit;
- simulated provider failure, timeout, invalid output, quota exhaustion, or revocation preserves local OCR and manual review;
- every new database object retains active-business isolation and deny-all direct Data API access;
- a Pro target has its organization Spend Cap on, excluded usage/add-ons inventoried, included compute retained, and no unapproved paid add-on;
- full automated gates pass, while physical-camera and real-receipt claims remain open until their separate evidence exists.

## Deferred Phase 3 provider ticket

### P3-AI-01: implement and benchmark the optional Azure receipt adapter

- **Priority:** P2 until the eligible benchmark corpus exists
- **Owner:** ai-ocr-analytics
- **Depends on:** completed Phase 1 guardrails, Phase 2 evidence readiness, a verified Azure F0 resource, and the frozen eligible corpus
- **Work:** implement a version-pinned `prebuilt-receipt` adapter through the provider-neutral seam and benchmark it without enabling production dispatch.
- **Acceptance:** the initial run uses at most 100 F0 page units, with no S0 paid units approved; one atomic reservation precedes every dispatch; other callers on the Azure resource are absent or reconciled; timeouts and ambiguous submissions are not automatically retried; invalid responses cannot overwrite a safer local value. Any 450-page production cap remains an unapproved post-pass candidate.
- **Rollback:** remove or disable the adapter and continue with local OCR plus owner review.
