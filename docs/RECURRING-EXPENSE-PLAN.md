# Recurring Expenses — Implementation Plan

Status: **All phases complete.** Phase 6 review done; its P1 and both P2s fixed
and re-verified.

Gate on a clean serialized run — backend **912/912**, web **182/182**, mobile
**195/195**; typecheck, lint and build green on all three.

Findings from the Phase 6 review, all resolved:

| Sev | Finding | Resolution |
|---|---|---|
| P1 | A schedule more than one cycle behind deadlocked, emitting a permanent false "missing payment" alarm at HIGH with a notification — about a bill that *was* paid | `advancedDueDate()` catches up in one pass via grid-preserving arithmetic (cannot spin; a due-on-the-1st bill stays on the 1st), capped at `MAX_CATCH_UP_CYCLES = 120` |
| P2 | Web filed and counted *paused* schedules as Overdue; mobile did not | Web reconciled to mobile — fourth "Paused" group, paused rows excluded from the badge |
| P2 | `border-edge-subtle` generated no CSS, silently falling back to a hard-coded non-themed grey | Both occurrences → `border-paper-200`; absence verified in the emitted CSS *and* JS bundle |
| P3 | The owner-fields regression test was partly vacuous | Rebuilt around normalized-equal-but-raw-different strings, then mutation-checked |
| P3 | `ANOMALY_RECURRING_ENABLED` undocumented | Added to `.env.example` and the runbook |

Security review passed: ownership isolation on all five endpoints (404 never
403), the confirm endpoint takes no body and derives `businessProfileId` /
`categoryId` from the fetched pattern so cross-tenant attachment is
structurally impossible, and the new table's RLS/grant tail matches the
deny-all posture.

**Not yet done, and needing a human:**

- The migration is applied ONLY to the throwaway test container. Production has
  no `RecurringSchedule` table and its 15 `RecurringPattern` rows are untouched.
  Applying it is a deliberate human action.
- `ANOMALY_RECURRING_ENABLED` ships **false**. The feature is dark until
  someone enables it, matching the other four staged-off detectors.
- Mobile's new `DateField allowFuture` path needs **physical-device
  verification** — `@react-native-community/datetimepicker` with
  `maximumDate={undefined}` differs between Android and iOS, and there is no
  render harness. Not covered by any automated test.
- No mascot pose exists for an empty recurring state (`04-empty-states/` is an
  empty directory on both clients), so both use a glyph.

## Test-infrastructure warning

The backend integration suite truncates every table between files and the whole
team shares ONE `finsight-test-db` container. **Two concurrent backend runs
destroy each other's fixtures**, producing large numbers of failures in files
unrelated to any change — this happened repeatedly during implementation
(111, 183 and 149 failures across three overlapping runs, all bogus; the same
tree ran 911/911 clean when it held the container alone).

Two practical notes:

- Run backend suites **one at a time**.
- `pgrep -f vitest` matches the shell running it, so a
  `until pgrep -f vitest; do ...` wait loop never terminates. Use
  `pgrep -fa "node.*vitest"`.

The durable fix is a database per agent (one env var) or serialised runs; it is
a shared-config change and therefore a team decision, not taken here. Until
then, treat a red backend run as *unproven* rather than as a regression — and
equally, do not wave a real regression through as "probably contention" without
confirming on an exclusive run.

## Decisions taken

1. **The 15 existing `RecurringPattern` rows stay.** Nothing is deleted. They
   read as seeded demo data — the same descriptions appear under two different
   business profiles with byte-identical amounts (`1999.00` internet,
   `4068.73` electricity, `12000.00` rent), which two independent businesses
   would not have. Either way the backfill reads only the single `CONFIRMED`
   row, the rest are inert, and they give the feature a realistic set of
   candidates to be exercised against once the flag is enabled.
2. **Notification emitter is in scope** (added as Phase 2.5). Without it the
   findings are raised and never delivered, and the feature is silent — which
   defeats the premise. Scoped to the schedule findings only, *not* to every
   HIGH finding on the `PROFILE_REFRESH` path: that path sweeps a profile's
   whole history, so a general rule would let a future operator enabling
   `trends` or `behavioralNovelty` emit a large burst from back-history in one
   pass. The `TRANSACTION` path is bounded to one record; this one is not.
3. **Due-soon lead time: fixed at 3 days**, as a named constant.

Open questions 4 (calendar grid) and 5 (interval bands) remain deferred.

## Why this exists

FinSight can already infer that an expense repeats, and can already be told
"yes, watch this." Neither half is reachable by an owner today:

- The detector is **off at runtime** and cannot be switched on from `.env`.
- A **confirmed** pattern disappears from both clients the moment it is
  confirmed, and there is no way to see it, edit it, or undo it.
- Editing would **silently revert** even if a form existed.
- The one alert it can raise is below the notification threshold, so the
  promise mobile makes ("You'll be notified if a confirmed payment is late")
  cannot be kept.

This is not hypothetical. The production database holds 15 patterns, one of
them `CONFIRMED`:

| Description | Amount | Interval | Next due | Observations |
|---|---|---|---|---|
| End-of-month staff salary payout | PHP 9,500 | 31 days | **2026-05-31** | 3 |

An owner asked FinSight to watch a PHP 9,500 salary payment. The underlying
records stopped in April. As of 2026-08-19 that is ~80 days silent, invisible
on every screen. That is the whole problem in one row.

## What this is NOT

**No auto-created expense records.** An auto-written record asserts money moved
when it may not have, and it feeds `availableFunds`, which is what an owner
makes decisions on. It also contradicts the product's own boundary statement
(`web/src/components/AuthLayout.tsx:114`):

> FinSight supports decision awareness. It is not an accounting, tax, payroll,
> POS, or banking system.

The owner records the payment. FinSight's job is to notice when they didn't.

---

## Phase 0 — Discovery findings (read before touching anything)

Everything below was read from source, not assumed. Cited so each phase can be
executed in a fresh session without re-deriving it.

### 0.1 The blocker that decides the architecture

`RecurringPattern` carries three DB-level CHECK constraints that Prisma does not
model. Verified present in the live database:

```sql
RecurringPattern_ObservationCount_check  CHECK ("RecurringPattern_ObservationCount" >= 3)
RecurringPattern_IntervalDays_check      CHECK ("RecurringPattern_IntervalDays" > 0)
RecurringPattern_Confidence_check        CHECK ("RecurringPattern_Confidence" >= 0 AND <= 1)
```

Source: `backend/prisma/migrations/20260807131343_recurring_patterns/migration.sql:25-27`.

**`ObservationCount >= 3` makes owner-declared schedules impossible in this
table.** An owner declaring "rent, monthly" before it has ever been observed has
zero observations, and the INSERT is rejected by Postgres.

Two more fields fight the same battle:

- `confidence` is `NOT NULL` and constrained to 0..1. It is a property of an
  *inference*. An owner-declared schedule has no confidence — it is a fact.
- `normalizedKey` is `NOT NULL` and unique per profile, and is
  `sha256(categoryId | vendor | description)` computed **from expense records**
  (`recurring.service.ts:33-36`). An owner-declared schedule has no records to
  derive a key from.

### 0.2 The detector clobbers everything except `status`

`recurring.service.ts:94-118`. The `update:` branch of the upsert rewrites
`categoryId, vendor, description, intervalDays, expectedAmount, amountTolerance,
confidence, observationCount, lastOccurrence, nextExpectedDate` on **every**
run. Only `status` is absent from both branches, which is the sole reason a
confirmation survives.

That list is exactly the set of fields an owner would want to edit.

### 0.3 `normalizedKey` must stay detector-owned

Because the key is hashed from the *records*, recomputing it after an owner
edits a description would leave the stored row unreachable by the next detector
pass — which would then create a second row for the same real-world payment.
**Never recompute `normalizedKey` from owner input.**

### 0.4 Conventions to copy (do not invent)

| Concern | Copy from | Note |
|---|---|---|
| Migrations | `backend/prisma/migrations/20260811090000_account_lifecycle/migration.sql` | Hand-written raw SQL, forward-only, no down-migrations. Schema-qualified `public."Table"`. Prose comments explaining *why*. `DO $$ ... RAISE EXCEPTION` pre-flight guards. |
| New-table SQL + RLS tail | `.../20260807131755_durable_analysis_jobs/migration.sql:1-47` | Every new table **must** end with `ENABLE ROW LEVEL SECURITY` plus the `DO $$ IF EXISTS (pg_roles ... 'anon')` revoke block. |
| Column naming | `schema.prisma:442-467` | Own scalars `Model_PascalField`; FKs use the *referenced* table's name (`BusinessProfile_ID`), not the owner's. |
| Zod schemas | `backend/src/controllers/expenseRecord.controller.ts:6-29` | Inline module-level `const createSchema` / `updateSchema` at the top of the controller. **No `validators/` or `schemas/` directory exists — do not create one.** Bodies use `z.number()`, queries use `z.coerce.number()`. PATCH = all fields `.optional()`. |
| CRUD service | `backend/src/services/expenseRecord.service.ts` (create `:131`, update `:493`, delete `:573`) | **Not** `expenseCategory.service.ts` — it has no update/delete. |
| Ownership (create/list) | `backend/src/lib/ownership.ts:7` | `await requireOwnedBusinessProfile(userId, businessProfileId)` as the first line. |
| Ownership (update/get/delete) | `expenseRecord.service.ts:494-500` | Scope the lookup `where: { id, businessProfile: { userId } }` and throw `ApiError(404, "... not found")`. Never a separate ownership query, never 403. |
| Category belongs to profile | `expenseRecord.service.ts:124-129` | Throws **400**, not 404 — the caller already proved profile ownership. |
| Route wiring | `backend/src/routes/insights.routes.ts` | `xRouter.use(requireAuth)` once, every handler in `asyncHandler`. |
| Decimal serialization | `insights.controller.ts:114-119` | Controller coerces Decimals with `Number(...)`. **Any new Decimal column must be added here or it serializes as an object.** |
| Grouped list (web) | `web/src/pages/Notifications.tsx:132-141` | `<section aria-label>` + uppercase `<h2>` + `<ul>`. This is the Overdue / This week / Later shape already. |
| Row (mobile) | `mobile/src/screens/RecordsScreens.tsx:185-255` | `Pressable > Card`, medallion, `<Money>`, caption meta joined with ` · `. |
| Tabs (mobile) | `InsightsScreens.tsx:195-209` (`SubTabs`), sections array `:494-498` | Badges count **decisions**, not unread items. |
| Web form | `web/src/pages/EditExpense.tsx:77-121` | `Field` + `TextInput` + `MoneyInput`; date is `<TextInput type="date">` on a `"YYYY-MM-DD"` string. |
| Mobile form | `mobile/src/screens/RecordsScreens.tsx:1261-1294` | `DateField` for dates; money is a plain `Field` with `keyboardType="decimal-pad"` — there is **no** mobile `MoneyInput`. |
| Date rendering | `web/src/pages/Dashboard.tsx:279-286` | `@db.Date` values **must** render with `timeZone: "UTC"` or they show the previous day. |
| Contract tests | `backend/tests/contract/fieldLimits.test.ts:1-63` | Imports the real schema across the project boundary. Any free-text field with a client `maxLength` must `export` its schema and be added to both `fieldLimits.ts` files. |

### 0.5 Anti-patterns (each caused a real defect or is one waiting)

- **Do not** add a `validators/` directory. Schemas live in controllers here.
- **Do not** relax or drop the three CHECK constraints to make owner rows fit.
- **Do not** recompute `normalizedKey` from owner-edited values (§0.3).
- **Do not** widen `z.nativeEnum(RecurringPatternStatus)` usage. It already
  accepts `DISABLED`, which **no code in `backend/src` reads or writes**
  (declaration-only in schema, migration, and the two client union types).
  Narrow it with `z.enum([...])` the way `insights.controller.ts:86` does.
- **Do not** render a `@db.Date` without `timeZone: "UTC"`.
- **Do not** assume a mascot pose exists. Only `01-onboarding/` has files;
  `04-empty-states/` and the other nine directories are **empty** on both
  clients. Use `icon` or ship an asset deliberately.

---

## The architecture: two tables, not one

`RecurringPattern` stays exactly as it is — the detector's inference output,
"FinSight noticed this repeats." A new `RecurringSchedule` holds owner intent,
"I told FinSight this repeats."

```
RecurringPattern  (detector-owned, machine-written)
      │  suggests
      ▼
RecurringSchedule (owner-owned, human-written, editable)  ──► the watchdog reads THIS
```

Why not override columns on the one table:

1. Owner rows cannot satisfy `ObservationCount >= 3`, `confidence NOT NULL`, or
   a records-derived `normalizedKey` (§0.1). Making them fit means weakening
   constraints that currently protect the detector's data quality.
2. The detector's hot-path upsert would need per-field conditional logic
   (§0.2) — the kind of thing that looks fine and silently stops protecting one
   field a year later.
3. Two ownership models in one table is precisely the confusion that produced
   the invisible-confirmed-row bug in the first place.

With two tables, "never clobber owner input" is enforced structurally: the
detector has no reason to write to `RecurringSchedule` at all.

---

## Phase 1 — Schema (owner: `database`)

**Files:** `backend/prisma/schema.prisma`, one new directory under
`backend/prisma/migrations/`.

Add `RecurringSchedule`:

| Field | Type | Notes |
|---|---|---|
| `id` | `Int @id` | |
| `businessProfileId` | `Int` | `@map("BusinessProfile_ID")`, cascade delete |
| `categoryId` | `Int` | `@map("Category_ID")`, cascade delete |
| `label` | `String @db.VarChar(255)` | What the owner calls it |
| `vendor` | `String? @db.VarChar(150)` | |
| `intervalDays` | `Int` | CHECK `> 0` |
| `expectedAmount` | `Decimal @db.Decimal(18,2)` | CHECK `> 0` |
| `amountTolerance` | `Decimal @db.Decimal(8,6)` | default `0.15`, CHECK `>= 0 AND <= 1` |
| `nextDueDate` | `DateTime @db.Date` | The owner's date. Never machine-written. |
| `lastRecordedDate` | `DateTime? @db.Date` | Detector-maintained tracking only |
| `isActive` | `Boolean @default(true)` | Pause without deleting — replaces the dead `DISABLED` enum value |
| `sourcePatternId` | `Int?` | FK → `RecurringPattern.id`, `ON DELETE SET NULL`. Provenance only. |
| `createdAt` / `updatedAt` | | |

Indexes: `@@index([businessProfileId, isActive, nextDueDate])` for the agenda
query; `@@index([categoryId])`; `@@unique([sourcePatternId])` so one pattern
cannot spawn two schedules.

**Deliberately absent:** `confidence`, `observationCount`, `normalizedKey`.
Those are inference properties and belong only to `RecurringPattern`.

**Migration requirements**

- Raw SQL, forward-only, matching `20260811090000_account_lifecycle`.
- **Must** end with the RLS + `anon`/`authenticated` revoke tail
  (`20260807131755_durable_analysis_jobs/migration.sql:32-47`). This is a hard
  rule in `CLAUDE.md`; a new table without it silently breaks the deny-all
  posture.
- Backfill: create one `RecurringSchedule` per existing `CONFIRMED`
  `RecurringPattern`, carrying `sourcePatternId`. Exactly **1 row** today, but
  write it as a set-based `INSERT ... SELECT` so it is correct for any count.
- `RecurringPattern` itself is **not altered**. No column drops, no CHECK
  changes, no data loss.

**Verification**

```bash
cd backend && npx prisma validate && npm run typecheck && npm run build
npm run test:db:up --prefix backend && npm test
```
Plus: confirm the migration is idempotent-safe on a fresh DB, and that the
backfill produced one schedule for the one confirmed pattern.

---

## Phase 2 — Detector + watchdog (owner: `ai-ocr-analytics`)

**Files:** `backend/src/services/anomalyDetection/{recurring.service.ts,config.ts}`.

1. **Wire the feature flag.** Add `ANOMALY_RECURRING_ENABLED` to
   `backend/src/config/env.ts` and to `RUNTIME_DETECTION_CONFIG`
   (`config.ts:55-64`), matching the four flags already there. Without this the
   feature stays dark regardless of everything else.

2. **Move the watchdog from patterns to schedules.** The three findings at
   `recurring.service.ts:120-174` (`recurring-missing`, `recurring-amount-change`,
   `recurring-repeated`) currently loop over `CONFIRMED` patterns. They must loop
   over active `RecurringSchedule` rows instead, matching records by
   `categoryId + vendor + label`.

3. **Add the forward-looking finding.** A new `recurring-due-soon` raised when
   `nextDueDate` is within N days and no matching record exists. *This is the
   piece that prevents forgetting rather than reporting it.* Everything today is
   retrospective.

4. **Advance `nextDueDate` when a matching record arrives** — schedule-side
   only. This is the one field the detector may write on a schedule, and only by
   adding `intervalDays`; it must never overwrite the owner's `expectedAmount`,
   `intervalDays`, or `label`.

5. **Severity.** `recurring-missing` and `recurring-due-soon` must be `HIGH`, or
   the notification threshold (`config.ts:42`, default `HIGH`,
   gate at `job.service.ts:20-23`) drops them. Alternative: lower
   `notificationMinimumSeverity` to `MEDIUM` — but that changes every other
   detector's noise level too, so **raising these two is the safer edit.**

6. Add a `NOTIFICATION_TYPES` member for schedule alerts
   (`notification.service.ts:11-16`).

**Anti-patterns:** do not write owner-set fields; do not recompute
`normalizedKey`; do not touch the `RecurringPattern` upsert branches beyond what
step 2 requires.

**Verification:** extend `backend/tests/integration/recurringPattern.test.ts`.
It already enables the flag via `detectionConfig({ featureFlags: { recurring: true } })`
(line 10) — copy that. Add cases: due-soon fires before the date; missing fires
after grace; a detector re-run does **not** alter an owner-edited
`expectedAmount`.

---

## Phase 3 — API (owner: `backend-api`)

**Files:** `backend/src/routes/insights.routes.ts`,
`backend/src/controllers/insights.controller.ts`, new
`backend/src/services/recurringSchedule.service.ts`.

The service is `backend-api`-owned, **not** under `anomalyDetection/` — it is
owner CRUD, not detection.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/insights/recurring-schedules` | Agenda list, with a computed `dueState` |
| `POST` | `/insights/recurring-schedules` | Owner declares one directly (solves cold start) |
| `PATCH` | `/insights/recurring-schedules/:id` | Edit amount / interval / date / category / label |
| `DELETE` | `/insights/recurring-schedules/:id` | Remove; or PATCH `isActive:false` to pause |
| `POST` | `/insights/recurring-patterns/:id/confirm` | Promote a candidate into a schedule |

Notes:

- Confirming becomes "create a schedule + set the pattern `CONFIRMED`", in a
  transaction. Keep the existing `PATCH /recurring-patterns/:id` for `DISMISSED`
  but **narrow its enum** to `z.enum([CONFIRMED, DISMISSED])` (§0.5).
- `dueState` (`OVERDUE | DUE_SOON | SCHEDULED`) is computed server-side so web
  and mobile cannot drift on the boundary rules.
- Coerce every `Decimal` with `Number(...)` in the controller
  (`insights.controller.ts:114-119`). Note `reviewRecurringPattern` at `:125`
  currently returns a raw row with **no** coercion — fix while adjacent.
- `label` is free text with a client `maxLength`, so `export` its schema and add
  a `fieldLimits` contract case (§0.4).

**Verification:** `npm run typecheck && npm run build && npm test`. Add an
ownership-isolation test: another owner gets 404, never 403.

---

## Phase 4 — Agenda list (owners: `web-frontend`, `mobile` — parallel)

The read view. **This is the phase that answers the original question**, and it
is worth shipping even if Phase 5 never happens.

Grouped **Overdue / Due this week / Later this month**, each row showing label,
expected amount, due date, and whether a matching record exists yet.

- **Web:** copy the grouped-list markup from `Notifications.tsx:132-141`. Place
  it on `ExpenseInsight.tsx`. Use `Button`, not the raw `<button>` elements the
  current recurring panel uses.
- **Mobile:** reuse the `"recurring"` section (`InsightsScreens.tsx:494-498`).
  The badge should count **overdue schedules**, not candidates — badges count
  decisions.
- **Fix the false empty state** at `InsightsScreens.tsx:992`, which currently
  tells an owner with confirmed schedules that none were found.
- Render `nextDueDate` with `timeZone: "UTC"` (§0.5). Neither client renders it
  at all today.
- Add `RecurringSchedule` to both `lib/types.ts`. Note the existing
  `RecurringPattern` client type has **no `categoryId`** — an edit form needs it.
- Consult `docs/mascot-scenario-library.md` and the `finsight-ui-polish` skill
  before choosing any token, and remember no `04-empty-states` pose exists yet.

**Verification:** each client's full gate, plus a test that an overdue schedule
renders in the Overdue group.

---

## Phase 5 — Declare + edit (owners: `web-frontend`, `mobile`)

Create/edit forms over the Phase 3 endpoints. Web copies
`EditExpense.tsx:77-121`; mobile copies `RecordsScreens.tsx:1261-1294` with
`DateField` and a `decimal-pad` `Field`. Include a pause (`isActive`) control
and delete with confirmation.

---

## Phase 6 — Verification (owner: `qa-security`)

Full gate across all three projects:

```bash
cd backend && npm run typecheck && npm run build && npx prisma validate && npm test
cd ../web   && npm run typecheck && npm run lint && npm test && npm run build
cd ../mobile && npm run typecheck && npm run lint && npm test
```

Beyond green: confirm ownership isolation on every new endpoint, confirm the new
table's RLS/grants match the deny-all posture, and confirm a detector re-run
does not alter owner-edited values — the defect this whole plan exists to
prevent.

`devops-release` adds `ANOMALY_RECURRING_ENABLED` to `backend/.env.example` and
the deployment runbook.

---

## Open questions

Questions 1-3 are settled — see [Decisions taken](#decisions-taken).

4. **Calendar month-grid.** Deferred by agreement — an agenda answers
   "what am I forgetting", a grid answers "how is my month shaped". Revisit once
   there is data on how many schedules an owner actually keeps.
5. **Interval bands.** `inferRecurringPattern` only recognises weekly (5-9),
   monthly (25-35), quarterly (80-100) (`recurring.service.ts:44-46`). Should
   owner-declared schedules allow any interval — fortnightly, annual? The schema
   above permits it; the detector would simply never suggest one.
