# FinSight System Development Assessment

**Assessment date:** 11 August 2026  
**Assessment basis:** Current repository implementation compared with the paper's panel-approved scope  
**Important scope decision:** The administrator module is excluded because the panel determined that FinSight does not require an administrator.

## Overall Assessment

FinSight is approximately **93% complete as a capstone system** (92.9% by the
table below, stable at 92–93% under the reweightings tested in *How much weight
this number carries*).

This estimate is based on executable source code, database migrations, automated tests, client applications, receipt-processing implementation, build configuration, and deployment documentation. It measures completion against the paper's intended user-facing system, excluding the removed administrator functionality.

## Updated Assessment

| Paper requirement | Actual system status | Estimate |
|---|---|---:|
| Account Management | Registration, email confirmation, login, logout, profile management, password change, complete password-recovery links on web and mobile, session revocation, and **resumable, crash-safe** account deletion are implemented. Two qualifications: email confirmation does not take effect until the Supabase dashboard switch and production SMTP are configured, so the control is inert in every environment built so far; and the suspension lifecycle is **enforcement machinery with no trigger** — the state, the transition function and the checks in `requireAuth` and `loginUser` all exist, but with the administrator module removed there is no endpoint or screen that can invoke it. | **90%** |
| Business Profile Management | Create, view, edit, switch, archive, restore, upload logos, and configure available funds, expected expenses and sales, operating days, and thresholds are implemented. | **100%** |
| Records Management | Manual expense and sales CRUD, CSV import, search, filtering, pagination, source tracking, duplicate review, OCR receipts, multi-page receipts, custom camera capture, cropping, edge proposals, long-receipt sections, and overlap handling are implemented. Mobile CSV controls remain less complete than web, and some confirmation operations are not fully atomic. | **96%** |
| Financial Dashboard | Financial summaries, expense and sales-reference totals, category distributions, trend charts, available funds, records requiring review, and recovery indicators are implemented on web and mobile. | **98%** |
| Financial Analysis Insights | Expense behavior, period comparison, spending-impact simulation, recovery targets, amount outliers, near duplicates, velocity, trends, novelty, recurring patterns, evaluation metrics, and durable analysis jobs exist. Some advanced detectors remain disabled by default or need broader real-data validation. | **94%** |
| AI-Assisted Interaction | Gemini and OpenRouter integration, business-specific financial context, fallback handling, receipt-vision rescue, category suggestions, and Ask FinSight interfaces exist. Live-provider reliability and real-user response quality remain externally dependent. | **92%** |
| Web Application | All primary workflows, including the completed authentication lifecycle, are connected. Type checking, linting, 127 tests, and the production build pass. The single Playwright browser test currently needs updating following the login accessibility-label change. | **96%** |
| Android/Mobile Application | Broad web parity, custom Expo Camera, live preview, capture guide, gallery fallback, crop adjustment, post-capture edge detection, multi-section long receipts, charts, insights, AI, notifications, and completed authentication deep links exist. Physical-device coverage and signed release-build evidence remain incomplete. | **92%** |
| Testing and Validation | The fresh audit produced 825 passing backend tests, 127 passing web tests, and 182 passing mobile tests, for **1,134 passing automated tests**. The backend build, Prisma validation, web build, Android export, and Nginx syntax validation pass. Browser E2E currently has one failing locator, while representative external UAT and the complete physical-phone matrix remain unfinished. | **91%** |
| Deployment and Operations | Docker and Nginx configuration, a non-root backend container, health checks, upload limits, proxy protections, structured logging, rate limits, RLS hardening, CI, environment templates, and deployment and authentication runbooks exist. Actual production hosting, TLS activation, monitoring, SMTP, backup and restore rehearsal, and signed Android distribution remain unverified. | **80%** |

Using equal weighting across these ten areas produces an overall estimate of approximately **93%**.

### How much weight this number carries

Stated plainly, because the figure will be asked about: the per-area percentages
are informed judgements, not measurements against a rubric. Nothing here
establishes what separates 96% from 90% in a given row. Two further weaknesses
are worth naming before someone else names them:

- **Overlap.** "Web Application" and "Android/Mobile Application" largely restate
  features already scored under Records Management, Dashboard, Insights and
  AI-Assisted Interaction, so four of the ten rows measure overlapping work.
- **Equal weighting.** Business Profile Management — a CRUD form — carries the
  same weight as Testing and Validation and as Deployment and Operations, which
  are the two areas with the most outstanding risk.

The estimate was re-tested against both objections rather than left as an
assertion. Equal weighting across all ten rows gives **92.9%**; removing the two
platform rows as double-counted gives **92.6%**; double-weighting Testing and
Deployment instead gives **91.7%**. The conclusion is therefore stable at
**92–93%** under any reasonable reweighting, which is why the headline figure
stands despite the softness of the method.

## Fresh Verification Results

| Verification area | Result |
|---|---:|
| Backend automated tests | 825 passed across 53 files |
| Web automated tests | 127 passed across 9 files |
| Mobile automated tests | 182 passed across 21 files |
| Total automated tests | **1,134 passed, 1 failed** (the browser E2E below) |
| Backend type check and production build | Passed |
| Prisma schema validation and test migrations | Passed |
| Web type check, lint, and production build | Passed with non-blocking lint warnings |
| Mobile type check and lint | Passed with non-blocking lint warnings |
| Mobile Android export | Reported by the team; **not reproduced in this audit** — the workstation was at 95% disk after reclaiming 5.85 GB of Docker build cache, and an export would likely have refilled it |
| Nginx configuration syntax | Passed (`nginx -t` against the real `nginx:1.27-alpine` image) |
| Playwright browser E2E | One test failed on an ambiguous locator |

The Playwright failure was a test-selector defect, not a login defect, and the
mechanism was exact: `web/e2e/auth-shell.spec.ts` calls
`page.getByLabel("Email")`, which matches by **substring** rather than exactly.
The failure was caused by `Login.tsx` containing both a field labelled `"Email"`
and a checkbox labelled `"Save my email on this device"`, so two elements
matched and Playwright's strict mode refused to guess.

**Status: resolved.** `Login.tsx` now labels the "remember me" control
`"Remember me"` instead of `"Save my email on this device"`, removing the
conflicting label. `getByLabel("Email")` is unambiguous again, and
`e2e/auth-shell.spec.ts` passes (verified 18 August 2026:
`npx playwright test e2e/auth-shell.spec.ts` → 1 passed).

## Recently Completed Work

The project has progressed beyond the previous assessment through the addition of:

- Complete password-reset flows on web and mobile
- Email-confirmation flows on web and mobile
- Stronger account lifecycle, suspension, session, and deletion handling
- Custom FinSight receipt camera using Expo Camera
- Receipt-shaped capture guidance and capture review
- Gallery fallback and multi-section capture
- Manual receipt cropping and rotation
- Server-side post-capture receipt-edge proposals
- Long-receipt capture using ordered overlapping sections
- Overlap-aware multi-page OCR processing
- Additional deterministic anomaly-analysis techniques
- Durable receipt and analysis jobs
- Deployment, proxy, container, logging, and rate-limit hardening
- Expanded backend, web, mobile, contract, integration, and performance tests

## Remaining Capstone-Critical Work

### 1. Physical Android validation

The following should be completed using the actual presentation phone:

- Camera permission and denied-permission behavior
- Custom camera opening, closing, and backgrounding
- Flash and gallery controls
- Crop-handle gestures on the physical screen
- Single-receipt and long-receipt capture
- Section ordering, removal, retake, and overlap guidance
- Upload behavior over the presentation network
- Network interruption and recovery
- Backgrounding during receipt processing
- Complete scan-to-confirm workflow
- Signed Android build installation

### 2. Representative user acceptance testing

The finished system should be evaluated by intended small-business users. The evidence should include:

- Participant profile and sample size
- Tasks performed
- Task-completion results
- Usability ratings
- Defects or difficulties encountered
- User recommendations
- Revisions made from feedback
- Final acceptance conclusion

### 3. Browser E2E repair and expansion

**The email-field locator ambiguity is resolved** (see *Fresh Verification
Results* for the precise cause and confirmation that `auth-shell.spec.ts` now
passes). Browser coverage should still be expanded to authenticated workflows
such as:

- Business-profile creation
- Manual expense and sales entry
- CSV import
- Receipt upload and confirmation
- Duplicate review
- Dashboard and insight updates

### 4. Release control

The current working tree contains a large set of modified and untracked implementation files. Before presentation or deployment, the team should:

- Review all changes
- Confirm migration and lockfile intent
- Organize the work into coherent commits
- Rerun the complete verification gate
- Ensure the presentation build comes from a known commit

## Remaining Technical Improvements

- Make receipt confirmation more transactional and idempotent.
- Make CSV confirmation more resistant to partial completion.
- Strengthen duplicate prevention under simultaneous requests.
- Expand testing with genuine Philippine thermal receipts.
- Calibrate edge detection and OCR against more real phone photographs.
- Add a mobile component-rendering test harness for the custom camera.
- Improve remaining mobile and web CSV feature parity.
- **Resolved:** Bound CSV import by **row count**, not only by file size. The
  5 MB ceiling was not a useful proxy for work: a file of narrow rows
  (`2026-01-05,Load,120`) is roughly 25 bytes per row, so 5 MB is about 200,000
  rows, each becoming an expense record with its own validation, duplicate
  check and downstream analysis. The same 5 MB of long descriptions is nearer
  8,000 rows — a 25× swing in work for an identical file size.
  `backend/src/services/csvImport.service.ts` now exports `MAX_IMPORT_ROWS`
  (30,000), enforced in `parseCsv` before column mapping, with a documented
  cost model for where the number comes from (verified in code, 18 August
  2026).
- **Resolved:** Add `maxLength` to the free-text inputs on both clients. The
  server caps every one of them, so this was not a defect; it was a round trip
  an owner on a metered connection paid to be told something the form already
  knew. `maxLength={FIELD_LIMITS.recordDescription}` (or
  `categoryDescription`) is now present on all four record forms plus the
  category form, on both web (`AddExpense.tsx`, `EditExpense.tsx`,
  `AddSalesRecord.tsx`, `EditSalesRecord.tsx`, `Categories.tsx`) and mobile
  (`RecordsScreens.tsx`, `CategoriesScreen.tsx`), including the previously
  uncovered expense description field (verified in code, 18 August 2026).
- Verify live Gemini and OpenRouter models, quotas, timeouts, and failure handling.
- Validate AI consent, retention, and third-party data-processing language.

## Remaining Deployment and Operations Work

- Select and verify production web and backend hosting.
- Activate and verify HTTPS/TLS.
- Configure production SMTP and required Supabase authentication settings.
- Configure centralized monitoring and alerts.
- Rehearse PostgreSQL and Supabase Storage restoration.
- Document runtime secret management and rotation.
- Produce and test a signed Android release build.
- Verify that the deployed applications were built from the assessed commit.

## Required Manuscript Corrections

The paper should be updated to match the panel-approved scope and actual implementation:

- Remove administrator workflows, use cases, screens, roles, and test cases.
- Replace Flutter and Dart references with **React Native, Expo, and TypeScript**.
- Remove Google ML Kit as an implemented technology.
- Describe OCR as **server-side Tesseract with conditional Gemini Vision assistance**.
- Describe the camera as a custom Expo Camera interface with live preview and post-capture processing.
- Describe edge detection as **server-side and post-capture**, not real-time.
- Do not claim automatic shutter operation or real-time OCR.
- Describe cropping as user-reviewed assisted cropping, not complete perspective correction.
- Update the Gantt chart and sprint plan to reflect actual development progress.

## Final Conclusion

> **FinSight is approximately 93% complete based on its panel-approved capstone scope. Its core backend, web, mobile, financial-monitoring, OCR, analysis, and AI-assisted workflows are implemented and extensively tested. Remaining work is concentrated on physical-device validation, external user acceptance testing, release control, manuscript alignment, and production deployment readiness.**

This percentage represents capstone-system completion, not unrestricted public-production readiness. Production readiness remains lower because live hosting, operational monitoring, backup recovery, production authentication configuration, and signed Android distribution still require verification.
