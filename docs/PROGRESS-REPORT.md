# FinSight System Project Progress Report

**Reporting date:** 7 August 2026

**Branch reviewed:** `feat/mobile-ui-refine`

**Branch HEAD:** `6ac5dd9`
**Current stage:** Feature-complete capstone candidate; internal acceptance and release-readiness work remain

## Executive summary

FinSight is a working financial-monitoring system for small-business owners. It includes a TypeScript/Express backend, React web client, React Native/Expo mobile client, PostgreSQL through Prisma, and Supabase Auth and Storage. Its core workflows—business management, sales and expense records, receipt scanning, CSV import, dashboards, insights, notifications, and AI-assisted questions—are implemented.

The project is suitable for a capstone demonstration after the remaining presentation-device checks are completed. It should not yet be described as production-ready: physical Android validation, backup and restore rehearsal, storage recovery, production hosting, and operational monitoring are still outstanding.

Fresh verification on 7 August 2026 reports **845 passing automated tests**: 658 backend, 75 web, 111 mobile, and one Playwright browser journey. Backend and mobile typechecks, the backend and web production builds, Prisma schema validation, and all 18 local test-database migrations also passed. The workstation initially ran out of disk space; clearing only disposable npm cache and generated build artifacts restored the verification environment.

## Status overview

| Area | Status | Current assessment |
|---|---|---|
| Backend/API | Green | Core APIs, ownership controls, durable receipt processing, and health checks are implemented |
| Web application | Green | Primary user journeys are implemented; recorded tests and production build pass |
| Mobile application | Amber | Broad feature coverage and recorded tests pass; physical-device evidence is incomplete |
| Database | Green | Prisma schema and 18 migrations are present; migration chain was previously verified locally and on hosted Supabase |
| Receipt/OCR | Green/Amber | Multi-page upload, OCR/vision extraction, review, correction, and reconciliation exist; real-receipt evidence is limited |
| AI and insights | Amber | AI categorisation, vision rescue, and Ask FinSight exist with fallbacks; live quality depends on providers |
| Security | Green/Amber | Auth, ownership isolation, RLS hardening, durable rate limits, and account deletion are implemented; production review remains |
| Internal acceptance | Amber | Hosted and automated web checks passed; presentation-phone checks remain |
| Deployment/operations | Amber/Red | Docker, nginx, and runbooks exist; hosting, TLS, monitoring, restore testing, and mobile distribution remain open |

## Completed capabilities

### Accounts and business profiles

- Registration, login, logout, password recovery, sessions, and protected routes.
- User and business-profile editing, switching, archiving, and business-scoped ownership enforcement.
- Password-confirmed account deletion with cleanup of receipt, CSV, avatar, and logo objects.

### Financial records

- Manual sales and expense creation and editing.
- Search, filters, categories, source provenance, anomaly flags, and duplicate resolution.
- Dashboard totals, trends, category breakdowns, recovery targets, and spending-impact scenarios.

### Receipt and CSV processing

- Single- and multi-page receipt uploads with ordered pages.
- Durable queued receipt processing with leases, heartbeat, stale-work recovery, bounded retries, and owner-triggered retry.
- Tesseract OCR, confidence scoring, vision-assisted rescue, line-item parsing, categorisation, and total reconciliation.
- Owner review before expense creation and extraction-correction feedback metrics.
- CSV validation, column mapping, category preview, import confirmation, and private source-file retrieval.

### Cross-platform clients

- Web flows for authentication, records, receipt review, CSV import, dashboards, insights, profile, help, and legal content.
- Mobile flows for authentication, business management, dashboards, records, receipt capture, CSV import, categories, insights, notifications, help, and Ask FinSight.
- Recent mobile refinements include dashboard charts, quick actions, spending breakdowns, category/help access, and improved navigation.

## Quality and acceptance evidence

Fresh candidate gate:

| Component | Result |
|---|---:|
| Backend | 658 tests passed across 32 files |
| Web | 75 tests passed across 5 files |
| Mobile | 111 tests passed across 15 files |
| Browser E2E | 1 Chromium journey passed |
| Type checks/builds | Backend and mobile typechecks, backend/web builds, and Prisma validation passed |
| **Total** | **845 tests passed** |

Hosted internal acceptance has covered registration and login, private Storage upload and signed retrieval, a synthetic receipt scan, CSV import, duplicate resolution, dashboard calculations, insights, Ask FinSight, and the rendered web dashboard. Detailed evidence is in `docs/internal-acceptance-results-2026-08-06.md`.

This is developer/internal acceptance evidence, not representative end-user UAT. Real Supabase Auth and Storage are mocked in much of the automated suite, live AI calls are excluded from deterministic tests, and the OCR corpus is mainly synthetic.

## Current working-tree position

The reviewed branch contains six recent commits for internal acceptance evidence, Supabase table security, stabilization documentation, web content, mobile UI refinement, and extraction feedback. On top of branch HEAD, the working tree currently contains **41 modified, deleted, or untracked paths** spanning backend, schema/migrations, web, mobile, tests, lockfiles, and documentation.

The uncommitted hardening work includes durable operations and indexes, receipt-worker changes, persistent rate limiting, account deletion, record pagination, web browser E2E coverage, and related client updates. These changes require review, a successful fresh gate, and coherent commits before integration.

## Risks and blockers

### Capstone-critical

1. The 41-path uncommitted change set is not yet release-controlled.
2. Physical Android camera capture, permission handling, backgrounding, network loss, and scan-to-confirm remain unverified. This now covers more surface than before: as of 8 August 2026 receipt capture uses FinSight's own Expo Camera interface with multi-section capture, manual cropping, and server-side edge detection (`docs/receipt-camera.md`). Its geometry, section limits, ordering, and overlap handling are unit- and integration-tested, but the camera components themselves are not — mobile still has no render harness, so permission states, camera lifecycle, gesture handling, and the physical-device matrix are verifiable only by hand. Report those as manual testing, never as suite coverage.
3. The presentation network, restart procedure, and offline fallback evidence still need rehearsal.

### Product quality

1. Real-receipt coverage is limited; synthetic fixtures do not represent all blurred, folded, faded, or poorly lit receipts.
2. External AI behavior and availability vary by provider configuration.
3. Known edge cases remain in minimum-history outlier detection and receipts whose vendor name appears in a footer.
4. The large-expense threshold is still a business assumption requiring stakeholder validation.

### Production and operations

1. No production hosting topology or TLS configuration has been finalized.
2. A database/object-storage restore rehearsal procedure is now documented
   (`docs/deployment-runbook.md` §6), but no one has actually executed it end
   to end yet — the procedure is written, not proven. Retention window and
   RPO/RTO targets also remain an open stakeholder decision (same doc, §10).
3. Structured logs exist, but centralized retention, alerting, and production probes are not configured.
4. A signed Android release/test build is not documented.
5. Leaked-password protection remains disabled for the synthetic capstone environment and must be enabled before real-user use.

## Recommended next steps

1. Review the 41 changed paths, confirm migration and lockfile intent, then commit the hardening work in coherent units.
2. Complete the physical Android sections of `docs/internal-acceptance-checklist.md` and capture screenshots or video evidence.
3. Rehearse the shortest presentation path using a clean synthetic account on the actual device and network.
4. Produce a signed Android test build and verify installation, permissions, capture, upload, backgrounding, and network recovery.
5. Before production use, select hosting and monitoring, configure TLS and probes, and demonstrate database and Storage recovery.
6. Expand browser E2E coverage to authenticated money-changing workflows and grow a privacy-safe real-receipt corpus.

## Overall conclusion

FinSight is no longer an early prototype. It is a broad, well-tested capstone candidate with meaningful safeguards around ownership, financial confirmation, receipt reconciliation, provenance, and AI failure behavior. The main milestone is now **candidate verification and presentation evidence**, followed by production operations—not another broad feature-development phase.
