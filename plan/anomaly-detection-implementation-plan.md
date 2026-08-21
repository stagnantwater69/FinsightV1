# FinSight Anomaly Detection Implementation Plan

## 1. Objective

Extend FinSight's existing Z-score, IQR, exact duplicate detection, notifications, and Insights features with a scalable and explainable anomaly-detection system without requiring scikit-learn.

The planned system will add:

- Near-duplicate detection
- Velocity and frequency detection
- Recurring-transaction monitoring
- Rolling trend and change detection
- Behavioral novelty scoring
- Unified findings, review actions, and user feedback
- Background processing and precomputed statistics for long-term scalability

## 2. Target Architecture

```text
Transaction created, edited, scanned, or imported
                    |
                    v
             Detection job queued
                    |
                    v
  +------------------------------------------+
  | Exact/near-duplicate detection           |
  | Z-score + IQR amount detection           |
  | Velocity/frequency detection             |
  | Recurring-payment monitoring             |
  | Behavioral novelty scoring               |
  +------------------------------------------+
                    |
                    v
           Unified anomaly findings
                    |
                    v
    Insights + Records + Notifications + AI
                    |
                    v
          User confirms or dismisses
```

## 3. Guiding Principles

- Keep every finding explainable to a non-technical business owner.
- Describe findings as unusual activity, not proof of fraud.
- Keep Z-score and IQR as dependable statistical detectors.
- Run each detector independently through a common contract.
- Make thresholds configurable and versioned.
- Isolate every query and finding by business profile and owner.
- Process expensive analysis asynchronously.
- Use rolling history instead of treating very old records as equally relevant.
- Preserve existing behavior while features are introduced incrementally.

## 4. Phase 1: Detection Foundation

Create a common contract for every detector.

```ts
type FindingType =
  | "amount_outlier"
  | "possible_duplicate"
  | "velocity_anomaly"
  | "recurring_change"
  | "trend_change"
  | "behavioral_novelty";

interface DetectionFinding {
  type: FindingType;
  severity: "low" | "medium" | "high";
  score: number;
  method: string;
  title: string;
  reasons: string[];
  metadata: Record<string, unknown>;
  detectorVersion: string;
}

interface TransactionDetector {
  detect(context: DetectionContext): Promise<DetectionFinding[]>;
}
```

Configuration must include:

- Statistical history requirement
- Rolling-window lengths
- Z-score threshold
- IQR multiplier
- Material-deviation threshold
- Velocity thresholds
- Duplicate-similarity thresholds
- Notification severity threshold
- Feature flags for each detector

### Acceptance criteria

- All detectors return the same finding structure.
- Every finding provides understandable reasons.
- Each detector can be disabled independently.
- Existing Z-score and IQR behavior remains covered by tests.
- Detector versions are saved with their findings.

## 5. Phase 2: Persistence and Database Design

Add a dedicated `AnomalyFinding` model instead of adding more Boolean fields to `ExpenseRecord`.

Suggested structure:

```prisma
model AnomalyFinding {
  id                Int       @id @default(autoincrement())
  businessProfileId Int
  expenseRecordId   Int?
  type              String
  method            String
  severity          String
  score             Decimal?
  title             String
  reasons           Json
  metadata          Json?
  detectorVersion   String
  status            String    @default("OPEN")
  detectedAt        DateTime  @default(now())
  reviewedAt        DateTime?
  feedback          String?
}
```

Finding statuses:

```text
OPEN
CONFIRMED
DISMISSED
RESOLVED
SUPERSEDED
```

Also introduce:

- `CategoryStatistics` for precomputed rolling summaries
- `RecurringPattern` for recognized recurring transactions
- A durable analysis-job table, or an extension of the existing durable-worker pattern
- Indexes on business profile, record, type, status, and detection date

Keep the existing `duplicateStatus` fields during migration for backward compatibility.

### Acceptance criteria

- Findings survive restarts and deployments.
- Findings can be traced to the detector version that created them.
- Deleting a business profile safely removes related analysis data.
- A finding cannot expose data belonging to another business profile.
- Re-running the same detector does not create uncontrolled duplicate findings.

## 6. Phase 3: Optimize Z-Score and IQR

Refactor the existing request-time, all-history analysis to use rolling baselines and precomputed statistics.

Initial baseline policy:

- Primary baseline: previous 12 months
- Short-term comparison: previous 90 days
- Configurable maximum number of records per category
- Candidate transaction excluded from its own baseline
- Minimum of eight historical records initially
- Existing 15% material-deviation requirement retained

Precompute the following values per category and window:

```text
count
sum
sum of squares
mean
standard deviation
q1
q3
minimum
maximum
window start
window end
calculated at
```

Refresh summaries after imports and with a scheduled job.

### Acceptance criteria

- Existing outlier tests continue to pass.
- A candidate never influences its own baseline.
- Old transactions outside the configured window do not distort present behavior.
- Insights remain responsive with at least 100,000 transactions in a business profile.
- Insufficient-history results are reported explicitly.

## 7. Phase 4: Improve Duplicate Detection

Preserve the current exact duplicate detector as the high-confidence path. Add near-duplicate scoring using:

- Exact or close amount
- Normalized vendor similarity
- Description similarity
- Date proximity
- Category match
- Receipt or import source

Initial configurable weights:

```text
Amount match             35%
Vendor similarity        25%
Description similarity   20%
Date proximity           15%
Category match            5%
```

Initial review thresholds:

```text
Score >= 0.90       High-confidence possible duplicate
Score 0.75 to 0.89 Review suggestion
Score < 0.75        Do not display
```

These weights and thresholds are starting assumptions and must be calibrated against test fixtures and user feedback.

### Acceptance criteria

- Exact duplicate matching remains deterministic.
- A near-duplicate finding never automatically deletes a transaction.
- Findings link to the suspected original transaction.
- Bulk imports detect matches within the file and against existing records.
- Similar transactions belonging to different businesses are never compared.

## 8. Phase 5: Velocity and Frequency Detection

Add rolling activity checks for:

- Repeated transactions with the same vendor within 24 hours
- Repeated amounts within 24 hours
- Transaction count changes over 1, 7, and 30 days
- Category spending changes over 7 and 30 days
- Several expenses just below the configured large-expense threshold

Prefer business-specific baselines:

```text
Current window count
versus
Median count from previous comparable windows
```

Example explanation:

> Five expenses were recorded for this vendor today. This business normally records zero or one per day.

### Acceptance criteria

- A large transaction alone is an amount finding, not a velocity finding.
- A burst produces one grouped finding instead of many notifications.
- CSV import time is not confused with the transactions' actual dates.
- Transaction date and database creation time are handled as separate signals.
- Businesses with insufficient history use conservative absolute rules or receive no velocity finding.

## 9. Phase 6: Recurring-Transaction Monitoring

Discover recurring candidates by grouping normalized:

```text
vendor + description + category + approximate amount
```

Recognize weekly, monthly, and quarterly patterns. Store:

- Expected interval
- Expected amount range
- Typical transaction date
- Confidence
- Observation count
- Last occurrence
- Next expected date
- User confirmation status

Generate findings for:

- Missing expected payment
- Duplicate occurrence
- Significant amount increase or decrease
- Unexpectedly early or late occurrence
- New possible recurring charge

Only activate a pattern after at least three consistent occurrences. Allow the owner to confirm or reject the inferred pattern.

### Acceptance criteria

- Irregular supplier purchases are not presented as confirmed subscriptions.
- Date tolerances account for weekends and varying month lengths.
- Amount ranges tolerate ordinary price variation.
- Editing or deleting a contributing transaction refreshes the pattern.
- Users can disable monitoring for a specific recurring pattern.

## 10. Phase 7: Rolling Trend and Change Detection

Add business-level and category-level comparisons:

- Current seven days versus previous seven days
- Current 30 days versus previous 30 days
- Current month versus previous month
- Current month versus the same month last year
- Category share of total expenses
- Income-to-expense ratio
- Cash-recovery trend

Require both a meaningful percentage change and a meaningful peso difference. This avoids exaggerated messages based on tiny values.

Trend findings normally belong in Insights rather than urgent notifications.

### Acceptance criteria

- Zero-value comparison periods are handled without infinity or misleading percentages.
- Partial current periods are compared with equivalent partial previous periods.
- Seasonal comparisons are clearly labelled.
- Materiality thresholds are configurable per business where appropriate.
- Each trend explanation includes the current value, comparison value, and date range.

## 11. Phase 8: Behavioral Novelty Scoring

Calculate separate explainable signals:

- Amount novelty
- Vendor novelty
- Category novelty
- Timing novelty
- Frequency novelty
- Description novelty

Example result:

```json
{
  "overallScore": 0.78,
  "signals": {
    "amount": 0.82,
    "vendor": 1.0,
    "category": 0.25,
    "timing": 0.31,
    "frequency": 0.73
  }
}
```

Combine the signals with configurable weights while retaining every component for explanation and evaluation.

Do not describe the result as a fraud probability. It is a review-priority score.

Initially create a finding only when:

- Multiple signals are meaningfully unusual; or
- One signal is extremely unusual and materially important.

### Acceptance criteria

- The UI can explain which signals contributed to the score.
- A new vendor alone does not create a high-severity alert.
- Missing optional information, such as vendor, does not increase risk automatically.
- Scores are reproducible for a given detector version and dataset.

## 12. Phase 9: Background Processing

Reuse FinSight's existing durable-worker approach.

Trigger analysis after:

- Manual transaction creation
- Transaction update
- Receipt confirmation
- CSV import completion
- Category reassignment

Use asynchronous processing so record creation remains responsive.

Scheduled work should:

- Refresh category summaries daily
- Discover recurring patterns daily
- Refresh trend findings daily
- Re-evaluate recent records after configuration changes
- Resolve or supersede stale findings

Detection must also support direct synchronous execution in unit and integration tests.

### Acceptance criteria

- Failed jobs can be retried safely.
- Processing is idempotent.
- One worker cannot claim the same job simultaneously with another worker.
- Job backlogs do not block HTTP requests.
- Graceful shutdown stops new claims and safely completes or releases current work.

## 13. Phase 10: API Integration

Suggested endpoints:

```text
GET   /insights/findings
GET   /insights/findings/summary
PATCH /insights/findings/:id/review
GET   /insights/recurring-patterns
PATCH /insights/recurring-patterns/:id
```

API requirements:

- Business ownership verification
- Filtering by type, severity, status, and date
- Pagination
- Stable response contracts shared by web and mobile
- Idempotent review actions
- Clear separation between findings and notifications

## 14. Phase 11: Web, Mobile, Notification, and AI Integration

Display:

- Finding type
- Severity
- Plain-language explanation
- Supporting values and date ranges
- Related transactions
- Confirm, dismiss, and resolve actions
- Detector name and version only in technical details

Suggested interface sections:

```text
Needs review
Spending changes
Recurring payments
Resolved findings
```

Group findings by transaction so one record does not appear as several unrelated alerts.

Only high-severity, actionable findings should create notifications. Trend findings should normally remain in the Insights experience.

Add confirmed findings to the AI context so Ask FinSight can explain them without inventing causes or treating them as fraud.

### Acceptance criteria

- Web and mobile show equivalent finding details and actions.
- Findings link to an accessible owned record.
- Dismissed findings disappear from the default review queue.
- AI responses distinguish observed facts from possible explanations.
- Notifications do not repeat when a detector reprocesses an unchanged record.

## 15. Phase 12: Feedback and Evaluation

Collect one of the following owner decisions:

```text
Confirmed unusual
Expected transaction
Duplicate
Incorrect match
No longer relevant
```

Measure quality per detector:

- Number of findings
- Confirmation rate
- Dismissal rate
- Findings per 100 transactions
- Processing latency
- Duplicate precision
- Notification volume
- Results by amount of available history

Build benchmark fixtures for:

- A new business with little history
- A business with several years of transactions
- A seasonal business
- Stable monthly expenses
- A CSV import burst
- Multiple legitimate same-day purchases
- An exact duplicate
- A near duplicate
- A missing recurring payment
- A sudden category increase
- A new vendor with an otherwise normal transaction
- A category whose prices changed gradually because of business growth or inflation

## 16. Security and Privacy Requirements

- Include `businessProfileId` in every analysis query and index.
- Verify profile ownership at API boundaries.
- Do not compare raw data across businesses.
- Do not expose internal thresholds as guarantees of fraud or correctness.
- Log detector failures without logging sensitive transaction descriptions unnecessarily.
- Retain review history for auditability.
- Define retention rules for jobs, statistics, findings, and feedback.

## 17. Performance Requirements

- Avoid recalculating every historical transaction when an Insights page opens.
- Use precomputed summaries for repeated calculations.
- Bound rolling-history queries by date and business profile.
- Paginate all finding lists.
- Process imports in batches.
- Benchmark profiles with 1,000, 10,000, and 100,000 transactions.
- Track API latency and background-job duration separately.

## 18. Testing Strategy

### Unit tests

- Detector arithmetic and boundaries
- Similarity normalization
- Velocity windows
- Recurring interval calculations
- Trend comparison rules
- Novelty signal calculation
- Severity and materiality mapping

### Integration tests

- Create and update triggers
- CSV import analysis
- Receipt-confirmation analysis
- Job claiming and retry behavior
- Finding persistence and review
- Notification deduplication
- Tenant isolation

### Contract tests

- Web and mobile finding payloads
- Pagination and filters
- Backward compatibility with current Insights responses

### Performance tests

- Large rolling-window queries
- Large CSV imports
- Daily summary refresh
- Backlogged job processing
- Concurrent workers

## 19. Delivery Sequence

### Sprint 1: Foundation

- Detector contracts
- Database models and migration
- Feature flags
- Benchmark fixtures
- Unified finding repository/service

### Sprint 2: Statistical Scalability

- Rolling Z-score and IQR baselines
- Category-statistics summaries
- Performance benchmarks
- Compatibility tests

### Sprint 3: Duplicate Improvements

- Vendor and description normalization
- Near-duplicate scoring
- Related-record review workflow
- Bulk-import coverage

### Sprint 4: Velocity Detection

- Rolling count and amount features
- Grouped velocity findings
- Import-aware handling
- Notification policies

### Sprint 5: Recurring Monitoring

- Pattern discovery
- Pattern confirmation
- Missing, repeated, and changed-payment findings
- Scheduled refresh

### Sprint 6: Trends and Behavioral Novelty

- Comparable-period calculations
- Material trend findings
- Explainable novelty signals
- AI context integration

### Sprint 7: Product Integration and Release

- Web and mobile finding experiences
- Feedback and review actions
- Monitoring dashboards
- Load and security tests
- Staged rollout

## 20. Release Strategy

Release every detector independently:

1. Run silently and save shadow findings.
2. Evaluate results against benchmark data.
3. Enable the detector for administrators or test accounts.
4. Display findings without sending notifications.
5. Measure confirmation and dismissal rates.
6. Adjust thresholds based on evidence.
7. Enable high-confidence notifications.
8. Retain a feature flag for immediate rollback.

## 21. Initial Production Milestone

The first production milestone should contain:

- Unified detector contract
- Persistent anomaly findings
- Rolling and optimized Z-score/IQR analysis
- Enhanced exact and near-duplicate detection
- Velocity and frequency rules
- Background analysis jobs
- Review and feedback actions
- Web and mobile review presentation
- Accuracy, isolation, and performance tests

Recurring transactions, trend changes, and behavioral novelty can follow without changing the core architecture.

## 22. Definition of Done

The implementation is complete when:

- Each enabled detector produces versioned, explainable findings.
- Findings are persisted, reviewable, and safely isolated by business profile.
- Transaction creation and imports remain responsive.
- The system performs acceptably for profiles with years of history.
- Web and mobile support the same core review workflow.
- Users can confirm or dismiss findings.
- Notifications are limited to high-confidence actionable findings.
- Automated tests cover detector correctness, tenant isolation, retries, and performance.
- Thresholds and feature flags can be changed without rewriting detector code.
- FinSight never presents an anomaly as confirmed fraud.

## 23. Implementation Reports

### Phase 1: Detection Foundation — Completed

Implemented shared detector contracts, versioned finding structures, rollout configuration, and staged feature flags. Existing amount and exact-duplicate detectors remain enabled while experimental detectors default to shadow/off mode.

Verification and findings:

- TypeScript contracts compile successfully.
- Detector configuration tests protect rollout defaults.
- A shared contract prevents each detector from inventing an incompatible API shape.

### Phase 2: Persistence and Database Design — Completed

Implemented `AnomalyFinding`, review feedback, `CategoryStatistics`, `RecurringPattern`, and durable `AnalysisJob` persistence with tenant-scoped keys, indexes, RLS, and deny-by-default Data API privileges.

Verification and findings:

- Migrations apply to a clean PostgreSQL database.
- RLS is enabled on new application tables.
- A globally unique detector fingerprint was rejected in favor of a business-scoped compound key to prevent cross-tenant collisions.

### Phase 3: Optimized Z-Score and IQR — Completed

Replaced unlimited all-history loading with a 365-day rolling baseline capped at 1,000 recent records per category. Added persisted 90-day and 365-day category summaries containing count, sum, sum of squares, mean, sample standard deviation, quartiles, minimum, and maximum.

Verification and findings:

- Leave-one-out scoring and the existing 15% materiality gate remain intact.
- Per-category SQL window limits prevent a busy category from crowding out smaller categories.
- Records older than the annual baseline no longer distort current anomaly decisions.

### Phase 4: Near-Duplicate Detection — Completed

Added explainable fuzzy duplicate scoring using amount, vendor, description, date proximity, and category signals. Exact matches remain authoritative. Fuzzy findings never delete records or alter exact-duplicate status and stale findings are superseded after edits.

Verification and findings:

- Cross-business comparisons are explicitly prevented.
- Missing vendors do not count as a positive match.
- The conservative 0.90 high-confidence boundary correctly kept a changed-description example at medium severity.
- The detector is available in shadow mode through `ANOMALY_NEAR_DUPLICATE_ENABLED`.

### Phase 5: Velocity and Frequency Detection — Completed

Implemented grouped 1-day, 7-day, and 30-day frequency checks for normalized vendors and categories. Each current window is compared with the median of four preceding equivalent windows. Findings require at least three current transactions, a minimum increase of two, and activity at least three times the historical median.

Verification and findings:

- Focused unit and integration tests pass.
- Activity is grouped into one finding per evaluated transaction instead of notification spam.
- Transaction dates drive windows, so a CSV upload timestamp does not create a false burst.
- A test fixture containing five transactions only in the current month was correctly identified as a monthly burst; the normal-activity fixture was expanded to five months of steady history.
- The detector defaults off and can be enabled through `ANOMALY_VELOCITY_ENABLED`.

### Phase 6: Recurring-Transaction Monitoring — Completed

Implemented recurring-pattern discovery for stable weekly, monthly, and quarterly sequences with at least three observations. Patterns store expected interval, amount, tolerance, confidence, observation count, last occurrence, and next expected date. Patterns begin as candidates and require owner confirmation before generating missing, early-repeat, or changed-amount findings.

Verification and findings:

- The migration applies cleanly and the recurring table is tenant-owned, indexed, protected by RLS, and hidden from direct client Data API access.
- Irregular sequences and histories shorter than three records are rejected.
- Owner confirmation is protected by business ownership checks.
- Candidate patterns create no warnings, reducing false alarms from inferred subscriptions or irregular suppliers.

### Phase 7: Rolling Trend and Change Detection — Completed

Implemented material 7-day and 30-day category trend comparisons. Trend findings require both a 25% relative change and a meaningful peso difference based on the business profile.

Verification and findings:

- Focused trend, novelty, and recurring suites pass.
- A large percentage movement on a trivial peso value is suppressed.
- Missing vendor information is not treated as suspicious.
- Trend detection remains staged behind `ANOMALY_TRENDS_ENABLED`.

### Phase 8: Behavioral Novelty Scoring — Completed

Implemented an explainable behavioral novelty detector retaining separate amount, vendor, category, timing, and description signals. It requires at least 20 historical records, an overall score of at least 0.65, and at least two strong signals before creating a finding.

Verification and findings:

- Normal behavior and histories shorter than 20 records are suppressed.
- Missing vendor data never increases novelty.
- Separate signal values are persisted for owner-facing explanations and later calibration.
- Results are review-priority scores, never fraud probabilities.
- The detector remains staged behind `ANOMALY_BEHAVIORAL_NOVELTY_ENABLED`.

### Phase 9: Durable Background Processing — Completed

Implemented leased PostgreSQL analysis jobs for transaction and daily profile work. Record creation, editing, receipt-derived creation, and CSV imports enqueue idempotent jobs. The worker runs amount, near-duplicate, velocity, and behavioral analysis for transactions, then refreshes category statistics, recurring patterns, and trends through daily profile jobs.

Verification and findings:

- Jobs use `FOR UPDATE SKIP LOCKED`, worker leases, stale-work reclamation, exponential retry delays, and a five-attempt terminal failure state.
- Editing a transaction requeues the same job instead of creating duplicates.
- CSV rows are enqueued in one batch and do not slow imports with synchronous fuzzy analysis.
- Daily profile jobs use a profile-and-date idempotency key.
- An hourly bounded reconciliation backfills any transaction whose initial enqueue was missed during a transient database failure.
- High-severity transaction findings create at most one matching notification on repeated analysis.

### Phase 10: Backend API Integration — Completed

Added authenticated endpoints for paginated findings, summaries, evaluation metrics, finding review, recurring-pattern listing, and recurring-pattern review.

Verification and findings:

- HTTP integration tests exercise the real authentication middleware with only the external token lookup mocked.
- Tenant isolation returns 404 for another owner's profile or finding.
- Decimal scores and recurring values are converted to numeric JSON values at the API boundary.
- Review actions are idempotent and pagination is capped at 100 rows.

### Phase 11: Web, Mobile, Notifications, and AI Integration — Completed

Added matching web and mobile review panels for open findings and recurring-pattern candidates. Owners can confirm findings, dismiss expected activity, confirm recurring expenses, or reject inferred patterns. Ask FinSight receives up to ten current explainable findings with an explicit instruction that they are not confirmed fraud.

Verification and findings:

- Backend, web, and mobile TypeScript checks pass.
- Web and mobile unit suites pass after integration.
- Only high-severity actionable transaction findings generate notifications.
- Duplicate notification checks prevent repeated worker runs from spamming the owner.
- Trend findings remain in Insights rather than producing urgent alerts.

### Phase 12: Feedback, Evaluation, and Scale Validation — Completed

Added detector-level confirmation and dismissal rates, findings per 100 transactions, average review latency, and analysis-job status metrics. Readiness output now includes queued and failed analysis-job counts.

Verification and findings:

- Evaluation metrics are ownership-scoped and covered by integration tests.
- A database-backed benchmark inserted 100,000 transactions and verified that analysis loads only the configured 1,000 recent records for the category.
- Feature flags permit immediate rollback of every experimental detector.
- Final full-suite, build, migration, RLS, and index results are recorded in the final verification report below.

### Final Verification Report

Completed on 2026-08-07.

Automated verification:

- Backend: 47 test files and 708 tests passed in the final full suite, including the queue-reconciliation and 100,000-transaction scale cases.
- Web: 5 test files and 75 tests passed; production Vite build completed successfully.
- Mobile: 15 test files and 111 tests passed; TypeScript compilation completed successfully.
- Web lint completed with no errors. Existing Fast Refresh organization warnings remain in pre-existing component/context files and are unrelated to anomaly detection.
- `git diff --check` reported no whitespace errors.

Database verification:

- All 22 migrations apply successfully to a clean PostgreSQL 16 test database.
- Supabase database advisors reported no security or performance issues on the migrated test schema.
- RLS is enabled on `AnomalyFinding`, `CategoryStatistics`, `RecurringPattern`, and `AnalysisJob`.
- Direct `anon` and `authenticated` application-table access remains revoked by the repository's deny-by-default policy.
- Seventeen primary, unique, ownership, status, date, worker-claim, and foreign-key indexes were confirmed across the four new tables.
- A 100,000-transaction database benchmark confirmed that category history remains capped at 1,000 rows per detector load.
- On 2026-08-07, the four anomaly-detection migrations were deployed successfully to the hosted Supabase project with `prisma migrate deploy`.
- The hosted project reports all 22 migrations applied. Post-deployment Supabase security and performance advisors returned no issues.
- Hosted catalog verification confirmed RLS on all four new tables, all 17 expected indexes, and direct grants only for `service_role` among `anon`, `authenticated`, and `service_role`.

System findings and release notes:

- Existing exact duplicates and Z-score/IQR logic remain the dependable baseline.
- Near-duplicate, velocity, recurring, trend, and behavioral techniques are explainable and independently gated.
- Experimental detectors default off until shadow results are evaluated; amount detection remains enabled.
- Findings are explicitly described as unusual or worth review, never as confirmed fraud.
- The hosted Supabase migration release is complete. Application deployment/restart and experimental-detector activation remain separate release operations.
