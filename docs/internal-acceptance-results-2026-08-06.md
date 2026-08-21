# Internal capstone acceptance results — 6 August 2026

Status: **In progress — hosted and web checks passed; physical Android checks
remain.** This is developer/internal acceptance evidence, not representative
end-user UAT.

## Environment

| Field | Value |
|---|---|
| Commit | `233ce55` |
| Tester | Codex live integration/browser automation; team phone tester pending |
| Backend | Local API on port 4000 using Supabase project `dgppgxtdzamxpufrcuqn` |
| Web | Local Vite app; Google Chrome 150 headless |
| Mobile | FinSight 1.0.0, Expo `~57.0.8`; Android bundle verified, device pending |
| Demo account | `capstone.demo.20260806@example.com` |
| Demo business | `Capstone Demo Store` (`Retail (Synthetic Demo)`) |

The account password is intentionally not committed. It was changed once
during the live Auth check and is included only in the task handoff. The
account, transactions, receipt image, and CSV files are all synthetic.

## Starting values

| Value | Expected | Hosted value | Result |
|---|---:|---:|---|
| Available funds | PHP 150,000.00 | PHP 150,000.00 | Pass |
| Expected monthly expenses | PHP 60,000.00 | PHP 60,000.00 | Pass |
| Operating days | 26 | 26 | Pass |
| Large-expense threshold | 20% | 20% | Pass |

Registration returned `201`; logout returned `204`; login succeeded both
before and after changing the password. Editing the business type persisted
through a fresh read.

## Synthetic records and independent totals

The manual dataset contains five expenses in three categories and three sales
reference records. One expense and one sale were edited before totals were
checked.

| Stage | Expenses | Sales reference | Largest category |
|---|---:|---:|---|
| Manual records only | PHP 7,050.00 | PHP 36,500.00 | Supplies — PHP 3,050.00 |
| After confirmed receipt | PHP 8,270.00 | PHP 36,500.00 | Supplies — PHP 4,270.00 |
| After CSV import (final) | PHP 9,270.00 | PHP 36,500.00 | Supplies — PHP 4,270.00 |

The final category totals are Supplies PHP 4,270.00, Utilities PHP 2,500.00,
Transport PHP 1,500.00, and Marketing PHP 1,000.00. Their displayed
percentages are 46.1%, 27.0%, 16.2%, and 10.8%, totaling 100.0% after display
rounding. Hosted SQL, the API dashboard, and the rendered web dashboard agree.

The web records screen displayed Manual Entry and CSV Upload source labels.
Searching for `wholesale` with the Sales filter returned the expected PHP
9,500 record and excluded expenses.

## Receipt and Storage

Fixture `syn-01-vendor-top-iso-date.png` is a generated, non-sensitive receipt
with expected values:

| Field | Expected | Extracted | Final | Result |
|---|---|---|---|---|
| Date | 2026-07-20 | 2026-07-20 | 2026-07-20 | Pass |
| Vendor | ALING NENA SARI-SARI STORE | Exact match | Exact match | Pass |
| Total | PHP 1,220.00 | PHP 1,220.00 | PHP 1,220.00 | Pass |
| Items | Rice PHP 1,050 + oil PHP 170 | Exact match | Exact match | Pass |

The upload returned `202 Processing`, reached `Complete`, and was confirmed
after replacing the generated description with a clearer synthetic-receipt
description. The resulting `RECEIPT_SCAN` expense reconciled to PHP 1,220.00.
Its private signed image URL returned `200 image/png`.

This validates hosted upload, OCR, polling, correction, confirmation, and
signed retrieval. It does **not** replace a camera capture on the presentation
phone.

## CSV import

- A one-row invalid file produced `Invalid amount: "not-a-number"` for row 2
  and imported zero records.
- Previewing the valid file identified `Marketing` as the new category before
  confirmation.
- The valid import created two records totaling PHP 1,000.00 with no skipped
  or flagged rows.
- The retained batch preview returned both source rows and its private signed
  download returned `200 text/csv`.

## Review, dashboard, and insights

A deliberate duplicate was flagged against the original record, appeared in
the flagged queue, was discarded through the resolution endpoint, and then
disappeared from that queue.

The final dashboard and manual calculations agree:

- available funds: PHP 150,000.00;
- 30-day expenses: PHP 9,270.00;
- sales reference: PHP 36,500.00;
- monthly expense target: PHP 60,000.00;
- base daily target: PHP 60,000 / 26 = PHP 2,307.69;
- remaining target: PHP 23,500.00;
- adjusted target: PHP 23,500 / 22 approximate remaining operating days =
  PHP 1,068.18;
- month coverage: 60.83%;
- PHP 5,000 spending scenario: 3.33% of funds, PHP 145,000 remaining,
  PHP 14,270 period expenses, Low Impact.

Daily and monthly cashflow points matched the dated source records. A live Ask
FinSight call through Gemini answered with PHP 9,270.00 expenses and PHP
36,500.00 sales reference, matching the selected business.

## Automated/build evidence

- Complete candidate gate: 843 tests passed (657 backend, 75 web, 111 mobile).
- Backend and mobile typechecks passed.
- Backend and web production builds passed.
- Android Expo export bundled 1,383 modules successfully to a temporary output
  directory using the configured development environment.

## Still blocked on physical evidence

The following items cannot be honestly completed from this workstation:

- capture and confirm a receipt using the presentation phone's camera;
- verify camera and photo-library permission prompts;
- background and reopen the Android app during processing;
- disable and restore the phone network during a scan;
- repeat the core record/dashboard path on the physical Android build;
- test at the presentation network/location;
- record fallback screenshots or video and restart the complete presentation
  stack before the final rehearsal.

The live provider-failure path and second-business isolation were not induced
against hosted data. Their deterministic automated coverage passes, but they
remain optional hands-on checks if the team wants live evidence.

## Decision

**Pending physical Android validation.** No Critical or High defect was found
in the hosted Auth/Storage/database/API flow or the automated web acceptance
path. The project should not be marked fully accepted until the physical-phone
items above are recorded.
