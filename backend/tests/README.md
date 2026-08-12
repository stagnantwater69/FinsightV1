# FinSight backend tests

## Running the suite

```bash
npm run test:db:up     # start the throwaway Postgres container (once)
npm test               # run everything
```

Other commands:

```bash
npm run test:watch        # re-run on change
npm run test:unit         # pure logic only, no database needed
npm run test:integration  # database-backed tests only
npm run test:db:down      # remove the test database container
npm run test:db:reset     # recreate it from scratch
```

## The test database

Tests run against a **local, throwaway Postgres container** on port `55432`, never
against the Supabase project. `.env.test` points there, and `tests/setup/globalSetup.ts`
**refuses to run** unless `DATABASE_URL` is a local database named `finsight_test`:

```
Error: Refusing to run tests against postgresql://user:****@db.…supabase.co:5432/postgres
The test suite truncates all tables. DATABASE_URL must point at a local database named finsight_test.
```

That guard matters because the integration tests `TRUNCATE` every table between
test files. Pointing them at the real project would destroy development data.

The schema is applied with `prisma migrate deploy`, so tests run against the real
migration history rather than a `db push` approximation of it.

`.env.test` is committed on purpose. Every value in it is fake — Supabase Storage
and the Auth admin API are mocked, and the AI providers are never called. If a
test ever does reach Supabase it fails loudly on the dummy credentials, which is
the intended behaviour: that is a test that needs mocking, not real keys.

### Supabase branching

A Supabase branch remains appropriate for a future external UAT study, but not
for this destructive automated suite or the current team-only capstone check.
The local container is free, fast, works offline, and can be discarded without
risking hosted data. Nothing in the automated suite depends on MCP or a hosted
Supabase project.

## Layout

```
tests/
  setup/
    globalSetup.ts   migrations + the safety guard
    testDb.ts        truncation, factories, UTC date helpers
  unit/              pure functions — no database, milliseconds
  integration/       real services against real Postgres
  ocr-accuracy/      OCR accuracy assessment (NOT part of npm test)
  ai-quality/        AI response-quality rubric (NOT part of npm test)
```

### Measuring against real receipts

`ocr-accuracy/` holds two scripts that read the **live database** rather than the image
corpus, using owners' confirmations as the labels:

```bash
npx tsx tests/ocr-accuracy/live-feedback-report.ts --days 30
npx tsx tests/ocr-accuracy/recalibrate-threshold.ts --days 90
```

They answer a different question from the corpus and do not replace it. The corpus is fixed,
so a change in its numbers is caused by a change in the code; the live sample moves every week
with whatever people photographed. **Judge a change with the corpus; find out what to change
with these.** Both read-only — the recalibration script prints a recommendation and edits
nothing. See [`docs/extraction-feedback.md`](../../docs/extraction-feedback.md) for what the
figures do and do not prove.

## What is covered

| Area | Where |
|---|---|
| Recovery-target maths, month boundaries, degenerate inputs | `unit/recoveryTarget.test.ts` |
| Z-score outlier detection, leave-one-out baseline | `unit/zScoreOutlier.test.ts` |
| Large-expense threshold (both bases) and impact banding | `unit/thresholdAndBanding.test.ts` |
| Scenario amount extraction | `unit/scenario.test.ts` |
| UTC date boundaries | `unit/dates.test.ts` |
| Receipt field parsing | `unit/ocrParsing.test.ts` |
| Record lifecycle: create → flag → resolve | `integration/recordLifecycle.test.ts` |
| CSV import, valid and invalid rows | `integration/csvImport.test.ts` |
| Receipt scan → confirm → expense record | `integration/receiptScan.test.ts` |
| Recording what owners correct on the confirm screen | `integration/extractionFeedback.test.ts` |
| Accuracy, calibration and error-cluster arithmetic | `unit/extractionMetrics.test.ts` |
| Ownership isolation across every resource | `integration/ownershipIsolation.test.ts` |
| Dashboard and insights against real rows | `integration/dashboardInsights.test.ts` |

## What is NOT covered, and why

- **Most HTTP routes, middleware and Supabase Auth.** Auth needs real Supabase
  tokens. Selected receipt HTTP behavior has integration coverage, while the
  complete registration-through-dashboard flow remains a manual clean-environment
  smoke test. Ownership rules are asserted at the service layer, where they are
  enforced.
- **Supabase Storage.** Mocked. Real uploads remain a manual UAT/deployment
  smoke-test requirement.
- **Real OCR on images.** Mocked in the integration tests so they stay
  deterministic; accuracy is measured separately in `ocr-accuracy/`.
- **Live AI calls.** Never made from `npm test` — no keys, and model output is
  not a pass/fail assertion. See `ai-quality/`.
- **Comprehensive browser end-to-end behavior.** The web suite has selected
  component tests, typechecking, and a production build, but not a complete
  browser workflow suite.

## Tests that pin known defects

Some tests assert current behaviour that is **wrong for the user** but not
silently changeable, so a future fix shows up as a deliberate, visible change:

- `unit/zScoreOutlier.test.ts` — "KNOWN DEFECT: false positives at the minimum
  history size". At exactly 5 records, both extremes of an ordinary category get
  reported as unusual.
- `unit/ocrParsing.test.ts` — "KNOWN LIMITATION: reads the wrong vendor when the
  name is in the footer".

## The two assessments outside `npm test`

Both make real external calls, cost money or minutes, and produce reports for
humans rather than assertions.

```bash
npx tsx tests/ocr-accuracy/run-assessment.ts   # ~5 min, no network
npx tsx tests/ai-quality/run-rubric.ts         # ~3 min, needs the backend running + AI keys
```

To rebuild the OCR corpus (needs Chrome and the source photos on disk):

```bash
python3 tests/ocr-accuracy/generate-corpus.py
```

Corpus images are not committed — some are real receipt photographs. `ground-truth.json`
and the generated reports are.

### Adding real receipt photos

**This is the highest-value thing anyone can do for extraction accuracy.** The corpus
is mostly synthetic renders, and a rendered receipt is not a photograph of a creased
thermal one — every figure in `OCR-ACCURACY-REPORT.md` is qualified by that.

Note what this is and is not: **no model is trained.** Tesseract is a fixed engine and
the vision model is an API. More images do not make extraction smarter on their own —
they reveal what is broken and prove a fix works instead of assuming it.

```bash
# 1. Drop photos into tests/ocr-accuracy/inbox/  (gitignored)
# 2. Draft the ground-truth entries:
npx tsx tests/ocr-accuracy/ingest-images.ts
# 3. Correct the drafts in ground-truth.json, then delete their needs_review flag
# 4. npx tsx tests/ocr-accuracy/run-assessment.ts
```

Step 3 is not optional and cannot be skipped. Drafts hold **what FinSight read**, not
what the receipt says; scoring against them grades the system on its own homework and
produces a number that cannot fall. `run-assessment.ts` therefore excludes every entry
still flagged `needs_review` and reports how many it skipped.

Aim for variety over volume — angled, creased, faded, dim, glare, long receipts, and
plain ones. A photo that already reads perfectly teaches nothing; the useful images are
the awkward ones.
