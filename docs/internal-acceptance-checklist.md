# FinSight internal capstone acceptance checklist

Use this checklist for the current team-only capstone evaluation. It is an
engineering and presentation-readiness check, not a representative end-user
study. Use synthetic transactions and non-sensitive sample receipts only.

## Evidence header

| Field | Value |
|---|---|
| Date | 2026-08-06 |
| Tester | Codex live automation; team physical tester pending |
| Commit | `233ce55` |
| Backend environment | Existing Supabase development project |
| Web device/browser | Google Chrome 150 headless; physical browser pending |
| Mobile device/Android version | Android bundle passed; physical device pending |
| App build or Expo version | FinSight 1.0.0 / Expo `~57.0.8` |

For each check, record **Pass**, **Fail**, or **Blocked**, plus a screenshot or
short note. A failed critical check blocks the capstone demonstration until it
is fixed and retested.

## 0. Safety and setup

- [x] Hosted-project security advisors contain no unaccepted critical finding
  (verified 2026-08-06; RLS enabled on 13/13 application tables and client
  table grants revoked).
- [x] The account and business are clearly labeled as capstone/demo data.
- [x] Transactions, CSV files, and receipts contain no real personal or
  business information.
- [x] Backend, web, and mobile point to the intended Supabase project and API.
- [x] `receipts` and `csv-imports` are private; `avatars` is public (verified
  2026-08-06).
- [x] The complete automated gate passes on the commit being demonstrated (843
  tests plus build/typecheck checks).

## 1. Account and business setup — critical

- [x] Register a new synthetic test account.
- [x] Log out and log back in.
- [x] Recover or change the password if the presentation includes that flow.
- [x] Create `Capstone Demo Store` with documented starting values.
- [x] Edit the profile and confirm the changes persist after refresh/relaunch.

Record the exact starting values:

| Value | Expected |
|---|---:|
| Available funds | PHP 150,000.00 |
| Expected monthly expenses | PHP 60,000.00 |
| Operating days | 26 |
| Large-expense threshold | 20% |

## 2. Manual financial records — critical

- [x] Create at least five expenses across two or more categories.
- [x] Create at least three sales records.
- [x] Edit one expense and one sale.
- [x] Search and filter the records.
- [x] Confirm source labels identify manual entries correctly.

Maintain an independent calculator or spreadsheet and record:

| Metric | Expected | FinSight | Match? |
|---|---:|---:|---|
| Total expenses | PHP 9,270.00 | PHP 9,270.00 | Yes |
| Total sales reference | PHP 36,500.00 | PHP 36,500.00 | Yes |
| Largest category | Supplies / PHP 4,270.00 | Supplies / PHP 4,270.00 | Yes |
| Available funds shown | PHP 150,000.00 | PHP 150,000.00 | Yes |

## 3. Receipt scan — critical

- [ ] Capture a non-sensitive sample receipt on the presentation phone.
- [x] Verify upload reaches a terminal processing state.
- [x] Compare extracted date, vendor, amount, and line items with the receipt.
- [x] Correct at least one field before confirmation.
- [x] Confirm the resulting expense records reconcile to the receipt total.
- [x] Confirm the source image can be viewed through a signed URL.
- [ ] Background and reopen the app during a second scan.
- [ ] Disable the network during a test and record the recovery behavior.

| Receipt field | Expected | Extracted | Final | Correct? |
|---|---|---|---|---|
| Date | 2026-07-20 | 2026-07-20 | 2026-07-20 | Yes |
| Vendor | ALING NENA SARI-SARI STORE | Exact match | Exact match | Yes |
| Total | PHP 1,220.00 | PHP 1,220.00 | PHP 1,220.00 | Yes |

## 4. CSV import — critical if demonstrated

- [x] Import the prepared synthetic CSV.
- [x] Verify column mapping and invalid-row messages.
- [x] Confirm category-creation preview before accepting it.
- [x] Confirm imported totals against an independent calculation.
- [x] Confirm the retained source file can be retrieved.

## 5. Review and duplicate handling

- [x] Trigger and resolve a possible duplicate.
- [x] Trigger or identify a record needing review.
- [ ] Verify the explanation and available resolution actions.
- [ ] Confirm resolving one business's record does not affect another business.

## 6. Dashboard and insights — critical

- [x] Dashboard totals match the independent calculation.
- [x] Category percentages total approximately 100%.
- [x] Daily and monthly cashflow points use the correct dates and values.
- [x] Recovery and spending-impact calculations match manual calculations.
- [x] Ask FinSight uses the selected business's figures.
- [ ] Provider failure produces a clear fallback rather than invented figures.

## 7. Cross-platform and presentation readiness — critical

- [ ] Repeat the core record and dashboard checks on web and Android.
- [ ] Verify camera and photo-library permissions on the presentation phone.
- [ ] Verify navigation, charts, greeting animation, help, and categories.
- [ ] Test at the actual presentation network/location if possible.
- [ ] Prepare fallback screenshots or a short recording for network/provider
  failure during the presentation.
- [ ] Restart all services and repeat the shortest critical path.

## Defects and retest log

| ID | Severity | Step | Expected | Actual | Fix/decision | Retest |
|---|---|---|---|---|---|---|
| | | | | | | |

Severity definitions:

- **Critical:** prevents login, data entry, receipt confirmation, correct
  financial totals, or the planned presentation path.
- **High:** major workflow works only with a workaround or shows misleading
  financial information.
- **Medium/Low:** localized usability, copy, layout, or polish issue.

## Acceptance decision

- [ ] All critical checks passed.
- [ ] No unresolved Critical or High defect remains on the presentation path.
- [x] Expected-versus-actual totals were independently checked.
- [ ] Physical Android evidence was recorded.
- [x] Limitations are disclosed honestly in the capstone report and the dated
  acceptance-results document.

Decision: **Pending physical Android validation**

Signed by: ____________________  Date: ____________________
