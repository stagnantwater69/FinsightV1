# FinSight System Improvement, Anomaly Detection, and Scalability Strategy

**Document purpose:** Consolidate the full technical and product discussion about improving FinSight's accuracy, anomaly detection, CSV-import scalability, reliability, AI architecture, security, user experience, and competitiveness.

**Status:** Architecture and product recommendation. This document distinguishes existing functionality from proposed work. It does not claim that recommendations have already been implemented.

**Last updated:** 2026-08-17

---

## 1. Executive Summary

FinSight is already a substantial financial-monitoring application rather than a basic prototype. It has web and mobile clients, an Express/TypeScript backend, Prisma/PostgreSQL, Supabase authentication and storage, receipt OCR, CSV import, dashboards, deterministic insights, anomaly findings, and optional AI-generated explanations.

The most important improvement opportunity is not immediately adding more advanced machine learning. The highest-value work is strengthening production trust:

1. Make CSV and receipt confirmation atomic, idempotent, and recoverable.
2. Move large imports into resumable background workflows.
3. Improve database-side aggregation and precomputed statistics.
4. Correct and calibrate the existing anomaly-detector lifecycle.
5. Complete identity, monitoring, backup, and security controls.
6. Measure real anomaly and categorization accuracy using owner feedback.
7. Improve review workflows so findings are useful rather than overwhelming.

For anomaly detection, FinSight should use a layered approach:

```text
Deterministic validation and integrity rules
                    ↓
Exact and near-duplicate detection
                    ↓
IQR, Z-score, median/MAD, and rolling baselines
                    ↓
Velocity, recurring, trend, and behavioral detectors
                    ↓
Optional Isolation Forest backup detector
                    ↓
Evidence combination, ranking, and grouping
                    ↓
Deterministic or AI-assisted plain-language explanation
                    ↓
Owner confirmation, correction, or dismissal
```

Isolation Forest can be useful, but only as a secondary background detector. It should not replace simpler statistical detectors, automatically modify records, or be treated as proof of fraud. It should initially run in shadow mode and must demonstrate that it finds useful anomalies missed by existing methods.

For a 25,000-row CSV, all valid rows should be analyzed, but not through one monolithic request or by sending all rows to an LLM. The recommended approach is streaming validation, staging, chunked idempotent insertion, one aggregate refresh, background anomaly processing, finding grouping, and sending only compact verified summaries to the AI.

FinSight's clearest competitive direction is:

> Fast and trustworthy financial monitoring for small-business owners, using explainable anomaly detection, low-friction record capture, and actionable insights without pretending to be a complete accounting or tax system.

---

## 2. Current FinSight Context

### 2.1 Current architecture

The repository currently contains:

- React/Vite web application.
- Expo/React Native mobile application.
- Express/TypeScript API.
- Prisma with Supabase PostgreSQL.
- Supabase Auth and Storage.
- Tesseract.js and Sharp for local receipt processing.
- Optional Gemini and OpenRouter integrations.
- Database-backed receipt and anomaly jobs.
- Manual, receipt-derived, CSV-derived expense records.
- Sales-reference records.
- Dashboard, insight, notification, and review interfaces.

### 2.2 Current anomaly capabilities

FinSight currently does **not** use scikit-learn, Python model serving, or Isolation Forest.

The current anomaly design uses:

- Z-score and IQR amount checks.
- Exact duplicate detection.
- Near-duplicate similarity logic.
- Velocity/frequency checks.
- Recurring-transaction patterns.
- Trend detection.
- Behavioral-novelty scoring.
- Persistent findings and owner feedback.
- Durable analysis jobs.
- Rolling or bounded historical queries.

Several advanced detectors exist but are disabled by default. The default enabled anomaly paths are primarily amount-outlier and exact-duplicate detection. This means FinSight should first validate and safely roll out what it already has before introducing another model family.

### 2.3 Current CSV behavior

The current CSV service:

- Accepts expenses, sales-reference records, and mixed files.
- Supports column mapping and preview.
- Validates missing descriptions, invalid dates, invalid amounts, and categories.
- Can create missing categories.
- Performs bulk inserts.
- Runs duplicate and large-expense checks.
- Allows up to 30,000 rows.
- Shows only a preview subset to the client.

Repository measurements recorded around five seconds for a typical 30,000-row bulk-create path in local PostgreSQL testing. However, parsing, upload, batch creation, categories, record creation, status changes, and notifications still form a request-bound workflow without a fully resumable state machine.

### 2.4 Current strengths

- Strong explainability foundation: findings store method, version, score, reasons, and metadata.
- Deterministic financial calculations remain server-side.
- Durable job tables support leasing, retry, stale recovery, and idempotency.
- Record provenance connects imports and receipt sources to resulting records.
- Cursor pagination supports large record histories.
- Money reconciliation uses integer units where precision is critical.
- Owner review remains authoritative.
- Tests include a 100,000-record anomaly-scale scenario.
- RLS and database indexing foundations exist.

### 2.5 Current limitations

- CSV confirmation is not fully atomic or resumable.
- Receipt confirmation can partially succeed and create ambiguous retry behavior.
- Exact duplicate detection has a concurrent read-before-write race.
- Some dashboard and insight calculations load record sets into Node.js.
- Several anomaly feature flags and lifecycle behaviors are inconsistent.
- The API, OCR, import, and analysis workloads are not fully isolated.
- Long anomaly jobs do not heartbeat through every phase.
- Search lacks specialized trigram or full-text indexing.
- Monitoring, error tracking, metrics, and alerting are not proven in production.
- Backup and restore behavior is not verified by a completed recovery exercise.
- Password-reset completion and email verification are incomplete.
- There is no anomaly calibration dashboard or feedback-analysis loop.
- Mobile CSV import and global search have weaker capability than web.
- General transaction export and audit trail are missing.

---

## 3. Anomaly Detection Technique Comparison

### 3.1 Summary table

| Technique | Primary anomaly type | Labeled data required? | Computational cost | Explainability | Best use |
| --- | --- | ---: | --- | --- | --- |
| Z-score | Amount far from mean | No | Very low | Excellent | Real-time and batch |
| IQR | Amount outside robust distribution fences | No | Low | Excellent | Real-time and batch |
| Robust Z-score using MAD | Amount far from median | No | Low | Excellent | Real-time and batch |
| Isolation Forest | Unusual multivariable combinations | No | Moderate | Medium to low | Background batch; cached online scoring |
| Local Outlier Factor | Local-density anomalies | No | Moderate to high | Low | Exploratory batch analysis |
| One-Class SVM | Boundary around normal observations | No anomaly labels required | High at scale | Low | Small offline datasets |
| DBSCAN | Rare clusters and isolated points | No | Moderate to high | Medium-low | Exploratory analysis |
| Supervised tree/classifier | Known issue classes | Yes | Moderate | Medium-high | When sufficient labeled feedback exists |
| EWMA/CUSUM/change detection | Persistent behavioral shifts | No | Very low | Excellent | Real-time and scheduled analysis |

### 3.2 Z-score

Z-score measures how many standard deviations a value is from its baseline mean:

```text
z = (amount - mean) / standard deviation
```

#### Detects

- Individual amounts far from the historical average.
- Large transaction-entry mistakes.
- Sudden high or low amounts in stable categories.

#### Strengths

- Very fast.
- Easy to update incrementally using count, sum, and sum of squares.
- Easy to test.
- Easy to explain to a business owner.
- Suitable for real-time record creation.
- Requires no labeled training data.

#### Weaknesses

- Financial amounts are often skewed rather than normally distributed.
- Existing extreme values inflate the mean and standard deviation.
- A mixed category may contain several legitimate amount scales.
- It only evaluates the amount unless additional features are added separately.
- It is unreliable when standard deviation is near zero or history is very small.

#### Suitability for FinSight

Keep it, but use it within business/category/vendor windows and combine it with IQR or MAD. Do not use one global baseline across unrelated expense categories.

### 3.3 IQR

IQR uses the first and third quartiles:

```text
IQR = Q3 - Q1
Lower fence = Q1 - multiplier × IQR
Upper fence = Q3 + multiplier × IQR
```

The common multiplier is 1.5, though this must be calibrated.

#### Detects

- Values outside the typical middle distribution.
- Extreme financial values even when the distribution is skewed.

#### Strengths

- More robust than mean/standard deviation when extreme values already exist.
- No normal-distribution assumption.
- No labeled data required.
- Highly explainable as a usual range.
- Appropriate for financial amounts.

#### Weaknesses

- Still ignores vendor, timing, description, and frequency.
- Requires enough historical values for meaningful quartiles.
- Percentiles are less trivial to maintain incrementally than mean/variance.
- A broad category can have a wide range and hide meaningful anomalies.

#### Suitability for FinSight

IQR should remain a primary amount detector. In many expense categories it is more reliable than Z-score alone.

### 3.4 Robust Z-score using median and MAD

Median absolute deviation is:

```text
MAD = median(|x - median(x)|)
Robust z = 0.6745 × (amount - median) / MAD
```

#### Strengths

- Resists distortion from extreme historical values.
- Retains an intuitive distance-from-typical interpretation.
- Fast enough for FinSight's expected volumes.
- Good for skewed supplier, utility, and inventory payments.

#### Recommendation

Implement MAD before Isolation Forest. It is likely to improve amount-anomaly quality at much lower operational complexity.

### 3.5 Isolation Forest

Isolation Forest creates randomized decision trees and measures how quickly an observation becomes isolated. Unusual observations tend to require fewer splits.

#### Detects

- Combinations of features that are unusual together.
- A normal amount from a first-seen vendor in a rare category.
- Normal-sized transactions appearing in an unusual burst.
- Moderately unusual signals that do not independently cross a rule threshold.

#### Potential features

- `log(amount)`.
- Amount divided by category median.
- Amount divided by vendor median.
- Robust amount Z-score.
- Vendor frequency.
- Category frequency.
- New-vendor indicator.
- Transactions from the vendor over 1, 7, and 30 days.
- Days since prior vendor transaction.
- Weekday.
- Description novelty.
- Recent spending divided by long-term spending.
- Expense relative to recent sales-reference totals.

#### Strengths

- Unsupervised; labeled anomalies are not required.
- Handles nonlinear multivariable patterns.
- Reasonably efficient at 25,000 or 100,000 records.
- Usually more practical than One-Class SVM at larger sizes.
- Can discover combinations that simple amount rules miss.

#### Weaknesses

- The score is not a business explanation.
- Feature engineering and normalization determine much of its quality.
- A separate model per small business may lack sufficient history.
- Global models can incorrectly compare dissimilar businesses.
- Historical anomalies can contaminate the training baseline.
- Seasonality and business growth can appear anomalous.
- Contamination settings can force a proportion of rows to be considered unusual.
- Model training, versioning, deployment, monitoring, and rollback add complexity.
- Adding scikit-learn introduces a Python runtime or service beside the TypeScript backend.

#### Correct role in FinSight

Use Isolation Forest as a **backup or secondary detector**, not the primary detector.

Recommended treatment:

| Detection result | User-facing behavior |
| --- | --- |
| Explainable statistical/rule detector only | Show direct evidence and appropriate severity |
| Isolation Forest only | Shadow mode or low-priority review; no push alert initially |
| Isolation Forest plus one explainable detector | Medium confidence/severity |
| Isolation Forest plus multiple detectors | High-priority review candidate |
| Insufficient clean history | Do not run Isolation Forest |

The raw model score must never be the explanation. FinSight must explain which interpretable features differ from the owner's baseline.

Bad user-facing message:

> Isolation Forest detected an anomaly with score -0.72.

Good user-facing message:

> **Unusual transaction pattern**  
> The amount is within the normal range, but this is the first transaction from this vendor, the category is rarely used, and four similar payments appeared within two days.

### 3.6 Local Outlier Factor

LOF identifies records whose local density is much lower than neighboring observations.

It can be useful for exploratory analysis, but it is sensitive to feature scaling and distance definitions, becomes more expensive at scale, is harder to score incrementally, and is difficult to explain. It is not a near-term priority.

### 3.7 One-Class SVM

One-Class SVM can learn a boundary around normal records but is sensitive to scaling and hyperparameters, scales poorly compared with Isolation Forest, and is difficult to explain. It is not recommended for FinSight's initial ML path.

### 3.8 DBSCAN

DBSCAN can find isolated points and rare clusters. However, mixed categorical and numeric transaction features make distance design difficult. It is useful for offline exploration, not for the primary product detector.

### 3.9 Trend and change-detection methods

For business owners, these may be more valuable than Isolation Forest:

- Rolling median and average.
- Week-over-week and month-over-month comparison.
- EWMA for gradual change.
- CUSUM for persistent shifts.
- Median current window versus median of historical comparable windows.
- Same-weekday or same-month seasonal comparison.

Example:

> Ingredient spending has remained above its previous 12-week range for four consecutive weeks.

This is typically more actionable than identifying a single opaque model outlier.

### 3.10 Are Z-score and IQR enough?

They are sufficient for straightforward **amount outliers** when used with appropriate category/vendor baselines.

They are not sufficient for:

- Exact and near duplicates.
- Transaction bursts.
- Missing or changed recurring expenses.
- Gradual changes in spending.
- Category changes.
- New or rare vendors.
- Unusual feature combinations.
- Sales declines.
- Structural business behavior changes.

The best answer is not necessarily immediate ML. A combination of deterministic rules, robust statistics, rolling windows, similarity, recurrence, and behavioral novelty can cover most important cases transparently.

---

## 4. Recommended Isolation Forest Rollout

### 4.1 Preconditions

Do not introduce Isolation Forest until FinSight has:

- Stable normalized vendor, category, date, and amount features.
- Sufficient transaction history for eligible businesses.
- Owner confirmation/dismissal feedback.
- Measured false-positive rates for current detectors.
- A dedicated background-worker environment.
- Model versioning and feature-schema versioning.
- Safe rollback and feature flags.
- Defined data-retention and model-retraining rules.

### 4.2 Shadow mode

Initially:

1. Train the model offline or in a background job.
2. Save Isolation Forest candidates internally.
3. Do not notify owners based solely on the model.
4. Compare candidates with existing detector results.
5. Ask reviewers or selected users to label a sample.
6. Measure incremental confirmed findings.

### 4.3 Evaluation metrics

- Confirmation rate by detector.
- Dismissal rate by detector.
- Alerts per 1,000 transactions.
- Incremental useful findings missed by rules/statistics.
- Detection latency.
- Feature-extraction latency.
- Model training time.
- Queue growth.
- Cost per analyzed business.
- Performance by business-size cohort.
- Performance by category and amount range.

### 4.4 Suggested architecture

```text
PostgreSQL records and summaries
              ↓
Versioned feature extraction
              ↓
Python/scikit-learn background worker
              ↓
Versioned Isolation Forest model
              ↓
Candidate anomaly scores
              ↓
TypeScript evidence and finding layer
              ↓
Grouped owner review
```

Keep the existing TypeScript API. Add only a bounded Python worker or offline service when justified.

---

## 5. Large CSV Import Strategy

### 5.1 Core recommendation

A 25,000-row import is manageable, but should become asynchronous and resumable. Every valid row should be processed, but the system should not perform all parsing, insertion, baseline refresh, anomaly detection, and AI explanation in one API request.

Recommended flow:

```text
Upload
  → File validation
  → Streaming row validation
  → Staging
  → Mapping and owner review
  → Chunked idempotent commit
  → Aggregate baseline refresh
  → Background anomaly analysis
  → Grouped findings
  → Optional AI explanation
```

### 5.2 File-level validation

Validate:

- File type and actual signature.
- Encoding and BOM.
- File size.
- Row count.
- Column count.
- Required headers.
- Unique header names.
- Delimiter consistency.
- Field-length limits.
- Duplicate file checksum for the business.
- Formula-injection risks if data can later be exported.
- Whether the date range is plausible.
- Whether the declared currency and amount format are consistent.

### 5.3 Row-level validation

Validate:

- Required description.
- Required date.
- Strict and explicit date format.
- Ambiguous dates such as `01/02/2026`.
- Impossible dates.
- Far-future dates.
- Finite amounts.
- Positive amounts where required.
- Signed amounts only under the selected import convention.
- Decimal precision.
- Thousands and decimal separators.
- Currency symbols.
- Parenthesized negative values.
- Maximum supported amount.
- Record type consistency.
- Missing expense category.
- Vendor/description/category length.
- Unexpected control characters.

Do not silently guess ambiguous dates. Ask the user to confirm the file's format once and apply it consistently.

### 5.4 Data-quality statuses

Each staged row should be classified as:

```text
VALID
VALID_WITH_WARNING
INVALID
POSSIBLE_DUPLICATE
NEEDS_CATEGORY
```

Store:

- Source row number.
- Raw values.
- Normalized values.
- Error or warning codes.
- User corrections.
- Import batch.
- Processing chunk.
- Row fingerprint.

### 5.5 Duplicate detection

Use:

1. File checksum duplicate detection.
2. Exact normalized row fingerprints.
3. Within-import duplicate grouping.
4. Existing database duplicate comparison.
5. Near-duplicate scoring.

Never automatically delete financial records solely because they look duplicated. Let the owner review or use high-confidence idempotency keys where the system itself created the duplication.

### 5.6 Missing and incorrect categories

Use this order:

1. Case-insensitive exact match.
2. Owner-defined alias or vendor rule.
3. Historical vendor-category majority.
4. Conservative similarity/keyword suggestion.
5. Optional AI suggestion.
6. Uncategorised fallback.

Potential incorrect-category explanations should reference history:

> This transaction is categorized as Utilities, but 18 previous transactions from this vendor were categorized as Ingredients.

Do not auto-create AI-invented categories.

### 5.7 Extreme values and data-entry errors

Use layered checks:

- Type and range checks.
- Decimal-place checks.
- IQR.
- Robust Z-score.
- Vendor/category baseline.
- Powers-of-ten checks.
- Extra-zero possibility.
- Repeated identical amounts.
- Receipt or statement reconciliation when totals exist.

Example:

> This amount is exactly ten times your typical payment to this vendor. Check whether an extra zero was entered.

### 5.8 Unusual transaction patterns

Analyze:

- Vendor/category counts over 1, 7, and 30 days.
- Current count versus median comparable windows.
- Multiple amounts just below a large-expense threshold.
- First-seen vendor with high amount.
- Recurring payment amount/date deviations.
- Missing expected recurring transaction.
- Expense changes relative to recent sales-reference activity.
- Consecutive weeks above historical range.

CSV upload time must not be mistaken for the transaction time. Historical transaction dates drive behavioral analysis.

### 5.9 Historical baselines

Calculate:

- Daily, weekly, and monthly totals.
- Category and vendor totals/counts.
- Mean and standard deviation.
- Median and MAD.
- Q1, Q3, and IQR.
- Minimum and maximum.
- 30-, 90-, and 365-day windows.
- Weekday/month seasonality.
- Recent versus long-term changes.
- Sample count and data coverage.

When analyzing historical records, distinguish:

- **Past-only evaluation:** compare each record only with earlier records.
- **Retrospective data-quality evaluation:** compare against the complete imported distribution.

Past-only evaluation is historically accurate. Retrospective evaluation is faster but must not be described as what the system would have known at that time.

### 5.10 Analyze all rows or summaries?

Use both, at different stages:

- Validate every row.
- Store every valid normalized record.
- Use database/set-based checks over all rows.
- Calculate summaries once.
- Use summaries for repeated baseline queries.
- Run expensive detectors only on eligible candidates or bounded windows.
- Send only summaries and top findings to the LLM.

### 5.11 Chunking and transactions

Suggested insertion chunk size is approximately 1,000–5,000 rows, tuned by measurement.

Maintain one logical import batch with:

- Idempotency key.
- Source checksum.
- Current state.
- Total rows.
- Processed rows.
- Valid rows.
- Invalid rows.
- Inserted rows.
- Current chunk.
- Last error.
- Retry count.
- Timestamps.

Suggested import statuses:

```text
UPLOADED
VALIDATING
AWAITING_CONFIRMATION
IMPORTING
ANALYZING
COMPLETED
COMPLETED_WITH_WARNINGS
FAILED_RETRYABLE
FAILED_FINAL
CANCELLED
```

---

## 6. Ideal Data Analysis Pipeline

### Stage 1: Upload

Frontend:

- Select file and record type.
- Show upload progress.
- Collect mapping and date-format choice.
- Display a small preview.

Backend:

- Authenticate and verify business ownership.
- Apply file limits.
- Calculate checksum.
- Create import job.
- Store source provenance.
- Return a job ID quickly.

### Stage 2: Validation

- Stream the CSV.
- Validate headers and rows.
- Persist row issues.
- Avoid returning thousands of issues in one response.
- Group and paginate errors.
- Provide downloadable rejected-row output.

### Stage 3: Cleaning

- Trim whitespace.
- Normalize Unicode.
- Normalize currency formatting.
- Resolve declared negative conventions.
- Preserve raw values for auditability.
- Do not convert ambiguous values silently.

### Stage 4: Normalization

- Normalize comparison text.
- Normalize vendor aliases.
- Resolve category aliases.
- Convert money consistently using Decimal or centavos.
- Generate row fingerprints.
- Preserve source row and original values.

### Stage 5: Owner preview

Show:

- Total rows.
- Valid/importable rows.
- Invalid rows.
- Duplicates.
- Unknown categories.
- Earliest/latest date.
- Expense and sales totals.
- Representative warnings.

### Stage 6: Storage

- Commit normalized rows in chunks.
- Make each chunk idempotent.
- Record checkpoints.
- Preserve batch/source provenance.
- Write follow-up jobs through an outbox in the same transaction.

### Stage 7: Baseline refresh

- Recalculate only affected business/category/vendor/windows.
- Prefer set-based PostgreSQL aggregation.
- Store validated snapshots.
- Avoid recalculating the same baseline for every imported record.

### Stage 8: Statistical analysis

- Exact duplicate rules.
- Large-expense business threshold.
- IQR.
- Robust Z-score/MAD.
- Conventional Z-score as supporting evidence.
- Vendor/category relative amount.

### Stage 9: Behavioral anomaly detection

Run in increasing order of cost:

1. Near duplicates.
2. Velocity/frequency.
3. Recurring pattern changes.
4. Rolling trend/change detection.
5. Behavioral novelty.
6. Optional Isolation Forest.

### Stage 10: Finding aggregation

- Merge overlapping findings.
- Rank by financial impact.
- Increase confidence when detectors agree.
- Suppress repeated alerts.
- Group import-related findings.
- Limit notification volume.

### Stage 11: AI interpretation

Send the LLM structured summaries such as:

```json
{
  "currency": "PHP",
  "period": "2025-01-01 to 2026-07-31",
  "recordCount": 25000,
  "totals": {
    "expenses": 850000,
    "salesReference": 1240000
  },
  "topFindings": [
    {
      "type": "amount_outlier",
      "category": "Ingredients",
      "amount": 12500,
      "median": 2450,
      "usualRange": [1800, 3100],
      "detectors": ["IQR", "robust_z"],
      "historyCount": 22
    }
  ]
}
```

Do not send all 25,000 records.

### Stage 12: User-facing insight

Every insight should explain:

- What happened.
- What baseline was used.
- The comparison period.
- How large the difference was.
- Why it may matter.
- Confidence and limitations.
- What the owner can do next.

---

## 7. Accuracy Improvement Strategy

### 7.1 Deterministic responsibilities

Use deterministic code/database logic for:

- Required fields.
- Dates and amounts.
- Currency conventions.
- Ownership and authorization.
- Exact fingerprints.
- Receipt reconciliation.
- Financial totals.
- Percentage changes.
- Thresholds.
- Import idempotency.
- Record provenance.

### 7.2 Statistical responsibilities

Use statistics for:

- Amount outliers.
- Category/vendor baselines.
- Trend shifts.
- Frequency deviations.
- Seasonal comparisons.
- Recurring-amount tolerances.

### 7.3 ML responsibilities

Use ML only when it adds measurable value:

- Isolation Forest for multivariable anomaly candidates.
- Later supervised models when enough owner labels exist.
- Categorization suggestions after deterministic/history rules.

### 7.4 LLM responsibilities

Use LLMs for:

- Plain-language explanations over verified facts.
- Conversational access to calculated results.
- Conservative category suggestions.
- Vision fallback for difficult receipt images.

Do not use LLMs for authoritative money calculations, fraud declarations, deletion decisions, or silent category creation.

### 7.5 Confidence and uncertainty

Each finding should preserve:

- Method.
- Detector version.
- Feature/baseline version.
- Score.
- Reasons.
- Sample size.
- Evidence metadata.
- Data-quality warnings.
- Detectors that agreed.
- First detected and last detected timestamps.
- Owner review result.

Prefer calibrated labels such as low, moderate, and high confidence over arbitrary percentages.

### 7.6 False-positive control

- Require minimum history.
- Use category/vendor-specific baselines.
- Use rolling windows.
- Account for seasonality.
- Require material peso differences.
- Increase severity only when signals agree.
- Group related findings.
- Suppress repeated alerts.
- Notify only above a configured severity.
- Allow “expected activity” feedback.
- Tune by business-size cohort.

### 7.7 False-negative control

- Use several complementary detectors.
- Detect trends, not only extreme values.
- Monitor first-seen vendors.
- Detect near duplicates with text/date similarity.
- Detect recurring changes and missing occurrences.
- Periodically evaluate confirmed owner corrections.
- Sample non-flagged transactions during quality evaluation.

---

## 8. Performance and Scalability

### 8.1 Scale tiers

| Records per business | Recommended handling |
| ---: | --- |
| 1,000 | Direct indexed queries; synchronous small imports acceptable |
| 25,000 | Async imports preferred; bulk insertion; cached summaries |
| 100,000 | Database aggregation; dedicated workers; incremental statistics |
| 1,000,000+ | Streaming import; summary tables; workload isolation; archive/partition review |

### 8.2 Frontend responsibilities

- File selection and basic size/type checks.
- Mapping and date-format confirmation.
- Small representative preview.
- Progress polling or server events.
- Paginated error and finding review.
- Virtualized long lists.
- Debounced search.
- Cancel superseded requests.
- Chart summarized series, not raw millions of points.
- Never perform authoritative anomaly analysis in the client.

### 8.3 Backend responsibilities

- Authentication and ownership.
- Import orchestration.
- Idempotency.
- Validation rules.
- Background-job creation.
- Progress reporting.
- Provider orchestration.
- Structured errors.
- Feature flags and safe rollout.

### 8.4 PostgreSQL/Supabase responsibilities

- Canonical normalized records.
- Staging and import state.
- Unique fingerprints and constraints.
- Set-based validation.
- Aggregation by time/category/vendor.
- Summary tables/materialized views.
- Finding persistence.
- Job leasing.
- Review/audit history.

### 8.5 Suggested indexes

- `(businessProfileId, date, id)`.
- `(businessProfileId, categoryId, date)`.
- `(businessProfileId, normalizedVendor, date)`.
- `(businessProfileId, importBatchId)`.
- `(businessProfileId, reviewStatus, date)`.
- `(businessProfileId, status, severity, detectedAt)` for findings.
- Normalized exact fingerprint.
- Job `(status, nextAttemptAt, heartbeatAt)`.

Use `EXPLAIN (ANALYZE, BUFFERS)` with representative tenant sizes before deploying new indexes.

### 8.6 Summary tables

Consider:

- `BusinessDailySummary`.
- `BusinessMonthlySummary`.
- `CategoryDailySummary`.
- `VendorMonthlySummary`.
- `DataQualitySummary`.

Store totals, counts, review counts, anomaly counts, and statistical snapshot references. Refresh incrementally and periodically reconcile from source records.

### 8.7 Pagination

Continue using cursor/keyset pagination and extend it to:

- Findings.
- Notifications.
- Import errors.
- Receipt history.
- Audit events.
- Category review queues.

### 8.8 Caching

Cache:

- Dashboard summaries.
- Category statistics.
- Recent insight summaries.
- Stable category lists.

Cache keys must include the business/profile boundary. Prefer summary tables and short-lived application caching before adding Redis. Add Redis only after multi-instance measurement justifies it.

### 8.9 Worker separation

Support process roles:

```text
API
Import worker
Receipt/OCR worker
Analysis worker
Scheduled summary worker
```

This prevents OCR/import workloads from harming interactive API latency.

### 8.10 Likely bottlenecks

1. Request-bound CSV processing.
2. Node-side dashboard aggregation.
3. One analysis job/query pattern per imported record.
4. Sequential recurring-pattern operations.
5. Unindexed substring search.
6. Shared OCR/API resources.
7. Long jobs without continuous heartbeat.
8. LLM calls in interactive paths.
9. Unbounded finding/notification lists.
10. Excessive frontend refetching.

---

## 9. Reliability Strategy

### 9.1 Atomic receipt confirmation

One database transaction should cover:

- Final receipt values.
- Item corrections.
- Expense creation.
- Item-to-expense links.
- Receipt status.
- Outbox/job records.

Add a confirmation idempotency key and uniqueness invariant for scan-derived record groups.

### 9.2 Resumable CSV import

Use a durable state machine with checkpoints. Retrying the same request must resume or return the same logical result rather than insert again.

### 9.3 Outbox pattern

When saving a financial record that requires a notification, analysis job, cleanup action, or provider request, write an outbox entry in the same transaction. A worker performs the side effect afterward.

This avoids returning an ambiguous failure after the financial record was already committed.

### 9.4 Job controls

- Active heartbeats.
- Exponential backoff with jitter.
- Maximum attempts.
- Dead-letter state.
- Queue-age metrics.
- Per-business concurrency.
- Graceful shutdown.
- Manual retry controls.
- Idempotent finding writes.
- Explicit checkpointed backfills.

### 9.5 AI/provider failure strategy

```text
Deterministic facts
       ↓
Cached valid explanation
       ↓
Primary provider
       ↓
Optional secondary provider
       ↓
Template-based explanation
```

FinSight must remain useful without an external AI provider.

### 9.6 Monitoring and observability

Measure:

- API latency/error rate.
- Database query latency.
- Import throughput/failure rate.
- Queue depth and oldest job.
- OCR duration/confidence.
- Provider latency/errors/tokens/cost.
- Findings per 1,000 records.
- Confirmation and dismissal rates.
- Authorization failures.
- Storage cleanup failures.

Use correlation IDs across API requests, imports, receipts, jobs, and provider calls.

### 9.7 Backups and recovery

- Confirm PostgreSQL backup/PITR settings.
- Define RPO and RTO.
- Perform recurring restore drills.
- Document Supabase Storage recovery.
- Preserve migrations and configuration.
- Test deletion and disaster recovery.
- Record evidence from restoration exercises.

---

## 10. AI and LLM Architecture

### 10.1 LLM input policy

Do not send 25,000 raw records to Gemini or another LLM.

Reasons:

- Token cost.
- Latency.
- Privacy exposure.
- Numeric unreliability.
- Context limits.
- Difficult auditing.
- Poor signal-to-noise ratio.

Send:

- Aggregate totals.
- Baseline comparisons.
- Top-ranked findings.
- Deterministic reasons.
- A few relevant records.
- Confidence and limitations.

### 10.2 Response contract

Require the model to distinguish:

- Calculated fact.
- Interpretation.
- Suggestion.
- Limitation/uncertainty.

The backend must validate structured output and reject unsupported claims.

### 10.3 Graceful degradation

If AI is unavailable, use deterministic templates such as:

> Expenses increased by 18% compared with the previous month. Ingredient expenses contributed ₱14,200 of the increase.

Only conversational wording should be lost, not the calculation or insight itself.

### 10.4 AI privacy

- Minimize fields.
- Redact unnecessary personal data.
- Record provider/model provenance.
- Define retention and consent.
- Do not permit provider training unless explicitly approved.
- Offer deterministic/no-external-AI mode.

---

## 11. Explainability Design

### 11.1 Required finding explanation

Every finding should answer:

1. What happened?
2. What was it compared with?
3. Over what time period?
4. What is the usual range?
5. How large is the difference?
6. Why might it matter?
7. How much history supports it?
8. What should the owner review?

### 11.2 Example amount finding

> **Unusual ingredient expense**  
> A ₱12,500 expense from ABC Supplies was recorded on July 14. Your previous 22 ingredient purchases from this vendor were usually between ₱1,900 and ₱3,100, with a median of ₱2,450. This amount is about 5.1 times the usual median. Check whether the amount contains an extra digit or covers several purchases.

### 11.3 Example multivariable finding

> **Unusual transaction pattern**  
> The ₱8,200 amount is not unusually high by itself, but this is the first purchase from this vendor, it occurred in a rarely used category, and three similar payments were recorded within two days.

### 11.4 Avoiding false alarms

- Do not notify on every low-confidence finding.
- Group related anomalies.
- Require minimum history.
- Use material financial impact.
- Increase severity when detectors agree.
- Let the owner mark a pattern as expected.
- Suppress repeated alerts after owner confirmation.
- Show uncertainty when history is small.
- Never call an unusual transaction fraudulent without external evidence.

---

## 12. User Experience Improvements

### 12.1 Dashboard hierarchy

The dashboard should quickly answer:

1. What needs attention?
2. How is the business doing?
3. What changed?
4. What should happen next?

Suggested order:

- Review-required summary.
- Cash/recovery status.
- Expense versus sales-reference totals.
- Important category changes.
- One short actionable insight.
- Secondary charts.

### 12.2 Import experience

Show:

```text
Uploaded → Checked → Ready → Importing → Analyzed
```

Add:

- Automatic mapping suggestions.
- Explicit date-format selection.
- Expense/sale detection preview.
- Totals before confirmation.
- Unknown-category grouping.
- Duplicate summary.
- Downloadable error file.
- Resume after connection loss.
- Safe retry.
- Undo import.
- Apply one correction to similar rows.

### 12.3 Review experience

Group findings into:

- Possible duplicates.
- Unusual amounts.
- Category questions.
- Spending bursts.
- Trend changes.

Support safe bulk actions:

- Keep selected.
- Mark expected.
- Change category.
- Apply vendor rule.
- Merge aliases.
- Dismiss similar low-risk findings.

### 12.4 Search and navigation

- Mobile global search parity.
- Saved filters.
- Recent searches.
- Vendor/category/date/source/import filters.
- Preserve filters when returning from details.
- Link every insight to supporting records.

### 12.5 High-value helper features

- “Always use this category for this vendor.”
- One-tap “This was expected.”
- Extra-zero warning.
- Duplicate-file checksum warning.
- Undo last import.
- Download rejected rows.
- Data-completeness indicator.
- “Last updated” on insights.
- Calendar-aware comparisons.
- Import templates.
- Recent vendor/category suggestions.
- Category merge/rename.
- Plain-language financial glossary.
- Offline draft preservation.
- Notification preferences and quiet summaries.

### 12.6 Avoid overload

- Show grouped summaries first.
- Reveal technical details on demand.
- Limit push/high-urgency alerts.
- Use owner-friendly language.
- Clearly separate errors, warnings, and insights.
- Do not expose raw model scores as the main message.

---

## 13. Security and Privacy

### 13.1 Authentication

- Complete password-reset callback and new-password flow.
- Enforce email verification outside controlled development.
- Revoke sessions after sensitive changes when appropriate.
- Consider MFA for sensitive/shared access later.
- Keep tokens and secrets out of logs.
- Use short-lived signed storage URLs.

### 13.2 Tenant isolation

The backend uses privileged access, making correct ownership predicates critical.

Add:

- Cross-tenant tests for every route and worker.
- Scoped service/repository helpers.
- Automated checks for new tenant-owned tables.
- RLS on exposed tables as defense in depth.
- Ownership checks in privileged functions.
- Assurance that service-role keys never reach clients.

### 13.3 Upload security

- Validate actual signatures, not only extensions.
- Limit MIME types and decoded image dimensions.
- Defend against decompression bombs.
- Restrict CSV rows, columns, and field lengths.
- Escape formula prefixes during export.
- Sanitize filenames.
- Store under generated object names.
- Consider malware scanning if arbitrary documents are introduced.

### 13.4 API security

- Configure `trust proxy` for the exact topology.
- Rate limit by account, IP, route, and expensive operation.
- Limit concurrent OCR/import/AI jobs per business.
- Apply body-size limits.
- Use strict CORS and CSP.
- Rotate secrets.
- Resolve dependency advisories through compatible upgrades.

### 13.5 Audit trail

Record append-oriented events for:

- Login/security changes.
- Record creation/update/delete.
- Import confirmation/undo.
- Category changes.
- Duplicate decisions.
- Anomaly decisions.
- AI-provider usage.
- Data export.
- Account/business deletion.

---

## 14. Competitive Principles

Mature financial systems feel professional because they prioritize:

- Reliable transaction ingestion.
- Matching and reconciliation.
- High-confidence automation with human review for uncertainty.
- Bulk workflows.
- Auditability.
- Clear status and provenance.
- Fast summarized reporting.
- Easy correction and undo.
- Consistent terminology.
- Predictable failure recovery.

FinSight should adopt these principles without copying another product's interface.

### 14.1 Must Have

- Atomic/idempotent financial writes.
- Resumable CSV and receipt processing.
- Password recovery and verified identity.
- Tenant-isolation tests.
- Backup/restore evidence.
- Monitoring and alerting.
- Audit history.
- Deterministic calculations.
- Data export.
- Clear error/recovery states.
- Database-side aggregation.
- Accurate duplicate handling.

### 14.2 High Impact

- Category rules learned from owner corrections.
- Vendor normalization.
- Robust statistics and rolling baselines.
- Bulk review actions.
- Mobile CSV/search parity.
- Category merge/rename/delete.
- Dedicated workers.
- Import undo.
- Explainable short-term cash-flow projection.
- Anomaly feedback measurement.

### 14.3 Competitive Advantage

- Explainable anomaly detection for non-accountants.
- Philippine small-business and peso-first context.
- Receipt-to-category insights with confidence and provenance.
- Spending-impact simulations.
- Evidence-linked “why this changed” explanations.
- AI that explains deterministic calculations.
- Privacy mode without external AI.
- Progressive learning from owner corrections without silent changes.

### 14.4 Nice to Have

- Isolation Forest backup detector.
- Bank feeds and reconciliation.
- Multi-user/accountant roles.
- Push/email summaries.
- Forecast scenarios.
- Industry benchmarks.
- Recurring bill reminders.
- Scheduled reports.
- Offline synchronization.

Bank feeds, formal reconciliation, invoicing, tax, and full accounting would materially expand product scope. They should not displace core reliability unless the product strategy explicitly changes.

---

## 15. Prioritized Roadmap

| Priority | Improvement | Problem solved | Expected impact | Difficulty |
| --- | --- | --- | --- | --- |
| P0 | Atomic/idempotent receipt confirmation | Partial or duplicate expenses after retry | Very high reliability | High |
| P0 | Resumable/idempotent CSV import | Partial imports and request timeouts | Very high reliability/scalability | High |
| P0 | Backup/restore verification | Unproven disaster recovery | Critical production trust | Medium |
| P0 | Complete password recovery and email verification | Broken identity lifecycle | Critical security/UX | Medium |
| P0 | Cross-tenant authorization suite | Financial-data exposure risk | Critical security | Medium |
| P0 | Monitoring, alerting, and correlation IDs | Invisible failures | Very high operational value | Medium |
| P1 | Correct anomaly lifecycle/configuration | Missing, stale, or duplicate findings | High accuracy | Medium |
| P1 | Database-side dashboard aggregation | Node memory and slow APIs | High performance | Medium |
| P1 | Separate API/import/OCR/analysis workers | Workload interference | High performance/reliability | Medium-high |
| P1 | Robust Z-score/MAD and rolling baselines | Skew-related false positives | High accuracy | Medium |
| P1 | Exact fingerprints and DB invariants | Concurrent duplicates | High data quality | Medium |
| P1 | Category rules, normalization, and merge | Repetitive categorization work | High UX/accuracy | Medium |
| P1 | Bulk review and import undo | Slow correction workflows | High UX | Medium-high |
| P1 | Audit event history | Limited traceability | High trust/security | Medium |
| P1 | AI minimization and deterministic fallback | Privacy/provider failures | High trust/reliability | Medium |
| P2 | Precomputed daily/monthly summaries | High-volume analytics | High scalability | Medium-high |
| P2 | Search indexing and complete pagination | Slow large-history navigation | Medium-high performance | Medium |
| P2 | Shared API schemas/OpenAPI | Web/mobile contract drift | Medium reliability | Medium |
| P2 | Expanded web/mobile E2E tests | Workflow regressions | High release confidence | High |
| P2 | Shadow rollout of disabled detectors | Unknown false-positive rates | High insight quality | Medium |
| P2 | Explainable short-term forecasting | Limited forward planning | High product value | Medium-high |
| P3 | Isolation Forest backup | Multivariable anomalies missed by rules | Uncertain until measured | High |
| P3 | Bank feeds/reconciliation | Manual ingestion/no matching | Major scope expansion | Very high |
| P3 | Multi-user roles/MFA | No collaboration | Valuable for larger businesses | High |
| P3 | Push and scheduled reports | Users must open app | Moderate engagement | Medium |

---

## 16. Top 10 Improvements to Implement First

### 1. Atomic and idempotent receipt confirmation

Prevents the most damaging failure: incomplete or duplicate financial records after retries.

### 2. Resumable background CSV import

Improves reliability for 25,000 records immediately and creates the foundation for 100,000+ records.

### 3. Database-backed fingerprints and idempotency constraints

Prevents simultaneous requests and ambiguous retries from silently duplicating records.

### 4. Monitoring, alerts, and correlation IDs

Makes stalled queues, failed imports, provider degradation, and slow queries visible before users report them.

### 5. Verified backups and restore drills

Financial data requires demonstrated recoverability, not merely configured backups.

### 6. Password recovery, email verification, and tenant tests

Completes baseline identity security and protects business data boundaries.

### 7. PostgreSQL-side dashboard and insight aggregation

Provides the most important performance improvement for large histories.

### 8. Correct and measure anomaly lifecycle behavior

Fix feature flags, re-detection, supersession, notification thresholds, and feedback metrics before enabling more detectors.

### 9. Robust statistics, vendor normalization, and category rules

Provides a larger immediate accuracy gain than Isolation Forest with lower complexity and better explainability.

### 10. Grouped owner review, bulk actions, and import undo

Makes the system practically usable when imports create dozens or hundreds of findings.

---

## 17. Recommended Implementation Sequence

### Phase 1: Production trust

- Receipt transaction/idempotency.
- CSV job state machine.
- Exact fingerprints.
- Password recovery and verification.
- Cross-tenant testing.
- Backup/restore exercise.
- Monitoring and alerting.

### Phase 2: Performance foundation

- Worker-role separation.
- Database aggregation.
- Summary tables.
- Complete cursor pagination.
- Search measurement and indexing.
- Import progress and error pagination.

### Phase 3: Detection quality

- Correct finding lifecycle.
- Add MAD/robust Z-score.
- Normalize vendors.
- Improve category rules.
- Shadow-test current disabled detectors.
- Add calibration reporting.

### Phase 4: UX and explainability

- Grouped review queues.
- Bulk actions.
- Import undo.
- Evidence-linked insights.
- Mobile parity.
- Notification preferences.

### Phase 5: Optional ML

- Versioned feature extraction.
- Isolation Forest shadow worker.
- Offline evaluation.
- Detector agreement rules.
- Low-severity rollout only if metrics justify it.

### Phase 6: Scope expansion only if strategically chosen

- Bank feeds.
- Formal reconciliation.
- Multi-user/accountant access.
- Broader forecasting.
- Scheduled reporting.

---

## 18. Final Decisions

### Should FinSight use Z-score/IQR only?

No. They are sufficient for amount anomalies but not duplicates, bursts, recurrence, trends, category issues, or multivariable behavior.

### Should FinSight add Isolation Forest now?

No. Not before import reliability, anomaly calibration, owner-feedback metrics, stable features, and worker isolation are complete.

### Should Isolation Forest be used as a backup later?

Yes. Use it as a feature-flagged, background, secondary detector. Isolation-Forest-only results should initially remain in shadow mode or low-priority review.

### What techniques are most valuable now?

- Exact/idempotent duplicate detection.
- IQR.
- Robust Z-score/MAD.
- Rolling category/vendor baselines.
- Near-duplicate similarity.
- Velocity/frequency rules.
- Recurring-pattern monitoring.
- EWMA or comparable-window change detection.
- Behavioral novelty.

### What should happen with 25,000+ records?

- Stream and validate all rows.
- Stage rows with errors and warnings.
- Commit in idempotent chunks.
- Refresh affected aggregates once.
- Analyze asynchronously.
- Group and rank findings.
- Send only summaries and supporting examples to the LLM.

### What should the overall architecture be?

- Frontend for upload, mapping, progress, review, and correction.
- API for authentication, ownership, orchestration, and policy.
- PostgreSQL for canonical data, constraints, aggregates, findings, and jobs.
- Dedicated workers for import, OCR, and analysis.
- Optional scikit-learn worker for later Isolation Forest.
- LLM for explanation of verified facts, never authoritative calculation.

### What should be postponed?

- Isolation Forest production notifications.
- LOF and One-Class SVM.
- Deep-learning anomaly detection.
- Raw-record LLM analysis.
- Automatic anomaly-driven deletion.
- Automatic creation of AI-invented categories.
- Bank/accounting expansion unless product strategy explicitly prioritizes it.

---

## 19. Success Metrics

FinSight should judge improvements using measurable outcomes:

### Accuracy

- Confirmed anomaly rate.
- Dismissed anomaly rate.
- Duplicate precision.
- Categorization acceptance rate.
- OCR field accuracy before/after correction.
- Percentage of findings with sufficient history.

### Performance

- P50/P95/P99 API latency.
- Time to preview/import 1k, 25k, and 100k rows.
- Queue wait time.
- Dashboard latency by tenant size.
- Database rows read per request.
- Worker throughput.

### Reliability

- Import success/retry rate.
- Duplicate records caused by retries.
- Dead-letter job count.
- Provider fallback rate.
- Restore drill success and duration.
- Storage orphan count.

### UX

- Time to complete an import.
- Time to clear review queue.
- Percentage of findings acted on.
- Undo usage.
- Search success.
- Mobile/web task completion parity.

### AI/ML

- Provider cost per active business.
- AI explanation failure rate.
- Unsupported-claim rate during evaluation.
- Isolation Forest incremental confirmed findings.
- Findings per 1,000 records by detector.

---

## 20. Closing Recommendation

FinSight should compete through trust, clarity, and usefulness—not through the number of AI models it contains.

The strongest near-term system is one where:

- Imports cannot silently duplicate or partially commit.
- Financial calculations are deterministic and auditable.
- Anomaly evidence is understandable.
- Uncertainty is visible.
- Owners remain in control.
- Large histories remain fast through database aggregation.
- AI improves communication without becoming the source of financial truth.
- External provider failure does not disable core insights.

Isolation Forest is a reasonable future backup detector, but only after FinSight can prove its incremental value. Until then, robust statistics, behavioral rules, better data normalization, reliable imports, and excellent review workflows offer the best balance of accuracy, performance, explainability, cost, and maintainability.
