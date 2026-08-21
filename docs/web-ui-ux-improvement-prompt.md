# FinSight Web — UI/UX Improvement Brief

**Target:** `web/` (Vite + React 19 + TypeScript + Tailwind 3)
**Audience:** Claude Code, or any developer picking up frontend polish work
**Written:** 2026-07-27, against the current state of `web/src/`

Paste this file as your first message when starting a UI/UX pass on the web
app. It is a work order, not a style guide — the style guide already exists in
the codebase and is described in §2.

---

## 1. The diagnosis in one paragraph

FinSight's web app does **not** have a design problem. It has an **adoption
gap**. `tailwind.config.js` and `src/index.css` carry a genuinely well-reasoned
three-theme token system (ink/paper/tint/tone/edge), and `src/components/`
contains a strong set of primitives — `Button`, `Money`, `Pill`, `Panel`,
`Card`, `DataTable`, `EmptyState`, `Skeleton`, `Toast`, `Alert`,
`Confirmation`, plus `useDebounced` / `useDismiss` / `useMenuKeys` in
`lib/hooks.ts`. The screens built *first and most carefully* — Dashboard,
Records, the AppShell — use all of it. The screens built around the edges —
every form, ScanReceipt, ImportCsv, FlaggedRecords, SpendingImpact, the auth
pages — bypass it and hand-roll the same markup instead.

The result is an app that is excellent on the two screens a demo starts on and
noticeably weaker on the eight screens a real user spends their time in. The
work below is mostly **deletion and substitution**, not new design.

**Do not redesign anything.** Do not introduce a new palette, a new component
library, a new font, or a new layout metaphor. Every fix in this document is
"use the thing that already exists here."

---

## 2. Non-negotiables

Read these before touching a file.

| Rule | Why |
|---|---|
| **Extend the existing design system; never replace it.** The token reasoning in `tailwind.config.js` and `src/index.css` is load-bearing and heavily documented. | Three themes (Classic/Light/Dark) resolve through those tokens. Hard-coded colours break the theme switcher silently. |
| **Never write a literal Tailwind colour** (`bg-slate-100`, `text-rose-800`, `bg-white`). Use `bg-paper`, `text-ink-700`, `bg-tint-danger text-tone-danger ring-edge-danger`. | A literal that looks right in Classic is unreadable in Dark. This is stated at length in `tailwind.config.js:124-166`. |
| **`accent-*` (amber) stays rare.** Recovery Meter + primary Save/Confirm CTAs only. | `tailwind.config.js:59-72`. If it leaks into chrome it stops meaning "this is the thing that matters". |
| **No new runtime dependencies.** Current deps: react, react-router-dom, axios, recharts, @supabase/supabase-js, @fontsource/*. That's it. | The brief in `CLAUDE-CODE-PROMPT.md:§3` fixes the stack. A component library would fight the token system. |
| **Single-role system.** No admin surface, no role checks, no user management. | `CLAUDE-CODE-PROMPT.md:§1` — hard scope constraint from the adviser. |
| **Never let a status be carried by colour alone.** Every pill, badge and severity ships a glyph *and* a written label. | `components/Alert.tsx:18` and `components/ui.tsx:22-25` already do this correctly — match them. |
| **Keep the 44px tap floor.** `min-h-tap` / `.tap` / `.tap-inline`. | Target users are on cheap Android phones. |
| **Preserve the existing code comments.** They explain *why*, and several document non-obvious failure modes (e.g. why `.shell` uses raw CSS instead of `@apply`). | Deleting the reasoning is how it gets undone six months later. |
| **Web and mobile must stay at parity.** | `CLAUDE-CODE-PROMPT.md:§1`. Anything added here has a mobile counterpart eventually. |

---

## 3. Findings inventory

Every item below was found in the current code. Line numbers are as of writing.

### 3.1 Primitives that exist but are bypassed

| # | Finding | Evidence |
|---|---|---|
| A1 | The `primary` button class string is **copy-pasted verbatim 13 times** across 10 pages instead of using `<Button variant="primary">`. | `pages/AddExpense.tsx:169`, `AddSalesRecord.tsx:90`, `EditExpense.tsx:121`, `EditSalesRecord.tsx:93`, `ScanReceipt.tsx:107,180`, `ImportCsv.tsx:169,255`, `Login.tsx:84`, `Register.tsx:140`, `RecoverPassword.tsx:57`, `Profile.tsx:106,261` |
| A2 | **No form-field primitive exists at all.** The string `rounded-lg border border-ink-200` appears in 17 files, ~55 times. | `pages/Login.tsx:53`, `AddExpense.tsx:121,134,145,160`, `SpendingImpact.tsx:151,163,183`, and everywhere else |
| A3 | Those hand-rolled inputs **omit `bg-paper text-ink-900`**, which `Records.tsx:272` includes. Field styling therefore differs between Records and every form. | compare `Records.tsx:272` with `AddExpense.tsx:121` |
| A4 | `Card`/`Panel` bypassed — `rounded-2xl bg-paper p-5 border border-paper-200 shadow-sm` written literally. | `FlaggedRecords.tsx:80,88`, `SpendingImpact.tsx:135,196` |
| A5 | `Pill` bypassed with hand-rolled `rounded-full bg-tint-* ...` spans. | `FlaggedRecords.tsx:98,111` |
| A6 | `Money` bypassed — raw `PHP {r.amount.toLocaleString()}`, so this figure is the only one in the app **not** tabular-aligned. | `FlaggedRecords.tsx:94` |
| A7 | Status chip uses **inline `style={{ backgroundColor }}`** with white text — not theme-aware, and white-on-amber is the exact contrast failure `Button.tsx` warns about (2.04:1). | `SpendingImpact.tsx:202,223` |
| A8 | `EmptyState` bypassed — "Nothing needs review right now." as a bare `<p>` in a box. | `FlaggedRecords.tsx:80-82` |
| A9 | `Skeleton` bypassed — plain `<p>Loading…</p>`, despite `Skeleton.tsx` being written *specifically* for OCR/CSV/AI waits. | `FlaggedRecords.tsx:78` |

### 3.2 Destructive actions and feedback

| # | Finding | Evidence |
|---|---|---|
| B1 | **Native `window.confirm()` used for 3 destructive actions.** Unthemed, unstyleable, ignores reduced-motion, and on the archive case tries to render a 3-line explanation inside an OS alert box. | `Records.tsx:128`, `FlaggedRecords.tsx:53`, `BusinessProfiles.tsx:54-58` |
| B2 | **No undo anywhere.** Delete is immediate and irreversible; `ToastProvider` exists and is the natural host for an undo affordance. | `components/Toast.tsx` is only wired into `App.tsx:52`, barely consumed |
| B3 | **Form errors are bare `<p>` with no `role="alert"`/`aria-live`.** A failed save is silent to a screen reader, and there's no focus move. | `Login.tsx:79`, `AddExpense.tsx:164`, `ScanReceipt.tsx:279,351`, `ImportCsv.tsx:537,622`, `FlaggedRecords.tsx:75`, `SpendingImpact.tsx:185` |
| B4 | Success after a mutation is communicated by **navigating away**, leaving the user to infer it worked. `Toast.tsx:288-292` explicitly names this as the problem it was built to solve — then isn't used for it. | `AddExpense.tsx:61`, `ScanReceipt.tsx:253` |
| B5 | `FlaggedRecords` "Keep"/"Discard" refetch the whole list with no optimistic update, no toast, and no confirmation of which record was resolved. | `FlaggedRecords.tsx:41-64` |

### 3.3 The three flows UAT measures directly

`docs/uat-feedback-form.md` defines pass/fail criteria. These findings map to
specific numbered statements the study will score.

| # | Finding | UAT item at risk |
|---|---|---|
| C1 | **ScanReceipt shows no image preview** — the user cannot see the receipt they uploaded while checking the extracted values against it. | 28 ("information read from my receipt was correct") |
| C2 | **No visual distinction between OCR-filled and OCR-missed fields.** A blank Vendor looks identical to a Vendor the user cleared. Nothing signals confidence. | 28, 29 |
| C3 | The "you can edit these" message is a small tinted line of 12px text above the form. Item 29 exists *because the design assumes owners notice this* — currently it is the quietest element on the screen. | 29 ("noticed values were editable") |
| C4 | OCR wait is a **button label change only** (`"Reading receipt…"`), no skeleton, no progress, no shape commitment. `Skeleton.tsx` names OCR as one of its three reasons for existing. | 27 ("scanning a receipt was easy") |
| C5 | **ImportCsv requires manual mapping of 4 columns** with zero auto-guessing, even when headers are literally `date`, `description`, `amount`, `category`. | 32 ("record a day quickly enough to do it regularly") |
| C6 | ImportCsv lets you **map the same CSV column to two fields** with no validation. | 32 |
| C7 | ImportCsv result screen reports "Flagged as possible duplicates: 3" as a dead number — **no link to review them**, no `Money` formatting. | 30 ("understood why records were marked as duplicates") |
| C8 | `FlaggedRecords` explains *what* was flagged but never *why* — no threshold shown, no comparison to the category average, no link to the record it duplicates (just `#id`). | 30, 33 (false alarms), 19 (trust) |
| C9 | The three setup figures (available funds, expected monthly expenses, operating days) drive **every downstream insight** and are presented as three plain number inputs with no explanation of what they mean or what they affect. | 23 — flagged in the scoring guide as "if owners misunderstand them, every downstream number is wrong" |
| C10 | Computed figures carry no provenance. The Dashboard does this well (`AiCard` subtitle: "Composed from your records — not AI-written"). Nowhere else distinguishes *entered* vs *computed* vs *AI-written*. | 19 ("I trust the numbers") — the scoring guide calls this the whole system's value |

### 3.4 Records at scale

| # | Finding | Evidence |
|---|---|---|
| D1 | **Search fires an API request per keystroke.** The effect depends on the whole `filters` object with no debounce — and `useDebounced` already exists in `lib/hooks.ts:244` and is used by GlobalSearch. | `Records.tsx:121-125` |
| D2 | `/records/search` returns the **entire result set**; `DataTable` paginates client-side. Fine at 50 records, not at 5,000. | `Records.tsx:94-105` + `DataTable.tsx:662-666` |
| D3 | **Filter state never written back to the URL.** It reads *from* the URL on mount (`Records.tsx:47-78`) but a filtered view can't be bookmarked, shared, or restored with the back button. | `Records.tsx:47-78` |
| D4 | After saving an expense, the app **refetches every expense record** purely to decide whether to show the first-record celebration. | `AddExpense.tsx:51-54` |
| D5 | Delete triggers two sequential full refetches with no optimistic removal. | `Records.tsx:127-132` |

### 3.5 Accessibility

| # | Finding | Evidence |
|---|---|---|
| E1 | **No skip-to-content link.** A keyboard user tabs through the entire sidebar (7 links + business switcher + collapse control) on every page. | `components/AppShell.tsx` |
| E2 | **No route-change announcement and no focus reset.** `<main key={location.pathname}>` remounts the page but focus stays wherever it was; a screen-reader user is not told the page changed. | `AppShell.tsx:962` |
| E3 | The Category `<label>` in AddExpense has **no `htmlFor`** and `CategorySelect` renders no matching `id`. The field is unlabelled. | `AddExpense.tsx:106` + `CategorySelect.tsx:416` |
| E4 | `CategorySelect` swaps the `<select>` for an inline create-form. Focus is not managed on either transition, and cancelling leaves the value empty with no announcement. | `CategorySelect.tsx:383-413` |
| E5 | File inputs are unstyled native `<input type="file">` with no filename echo, size validation, or type feedback. | `ScanReceipt.tsx:270-277`, `ImportCsv.tsx:528-535` |
| E6 | `AskFinSightDrawer` and the quick-add menu have dismiss + arrow-key handling (good) but **no focus trap** while open. | `AppShell.tsx:909-940`, `components/AskFinSightDrawer.tsx` |

---

## 4. The work, in order

Do these phases in sequence. Each is independently shippable and each makes
the next one smaller. **Commit per phase**, message format
`feat(web): <what>` or `refactor(web): <what>`.

---

### Phase 1 — Close the primitive gap

The single highest-leverage change. Everything after this gets cheaper.

**1.1 Build the missing form primitives** in a new `web/src/components/Field.tsx`.

Model them on `Button.tsx` — a small set of variants, the accessibility
obligation baked in so a call site cannot forget it, and a comment block
explaining the reasoning.

```
<Field label htmlFor hint error required>   // label + hint + error, wires
                                            // aria-describedby / aria-invalid
<TextInput />                               // themed input, min-h-tap
<SelectInput />                             // themed select, min-h-tap
<MoneyInput />                              // number input, PHP prefix,
                                            // inputMode="decimal", step .01
<FileInput />                               // styled drop target, filename
                                            // echo, size + type validation
```

Requirements:
- Every field renders `bg-paper text-ink-900 border-ink-200` — fixes A3.
- `error` sets `aria-invalid` and `aria-describedby`, and renders the message
  with `role="alert"` — fixes B3 at the primitive level, once, forever.
- `hint` renders as `text-ink-500` below the label, associated via
  `aria-describedby`. This is the mechanism §C9 needs.
- `MoneyInput` uses `inputMode="decimal"` — the current `type="number"` inputs
  give Android users the wrong keyboard for a currency amount.

**1.2 Replace all 13 hand-rolled primary buttons** with
`<Button variant="primary" type="submit" fullWidth disabled={submitting}>`.
Keep the existing `{submitting ? "Saving…" : "Save expense"}` label pattern —
it is correct.

**1.3 Migrate every form to `Field`**: `AddExpense`, `AddSalesRecord`,
`EditExpense`, `EditSalesRecord`, `Login`, `Register`, `RecoverPassword`,
`Profile`, `BusinessProfileForm`, `Categories`, `SpendingImpact`, `ImportCsv`,
`ScanReceipt`, `Records` (toolbar), `CategorySelect`.

**1.4 Fix the bypassed components:**
- `FlaggedRecords.tsx` → `Panel`, `Pill`, `Money`, `EmptyState`, `Button`, and
  the `SkeletonRows` loader instead of `<p>Loading…</p>`.
- `SpendingImpact.tsx:135,196` → `Panel`.
- `SpendingImpact.tsx:202,223` → `Pill` with the appropriate tone. Delete the
  inline `style={{ backgroundColor }}`; if no existing tone maps to the impact
  band, add the band to the `tint/tone/edge` triple set in `index.css` rather
  than hard-coding a hex.

**Done when:** `grep -rn "bg-accent-400" web/src/pages/` returns nothing, and
`grep -rc "rounded-lg border border-ink-200" web/src/` matches only
`Field.tsx`.

---

### Phase 2 — Destructive actions and the feedback loop

**2.1 Build `ConfirmDialog`** in `web/src/components/ConfirmDialog.tsx`.

Use the native `<dialog>` element with `showModal()` — it gives you the focus
trap, Escape handling, backdrop and inertness for free, and it is the one
place where less custom code is more accessible code. Style the backdrop via
`::backdrop`.

API, driven by a `useConfirm()` hook so call sites read as a one-liner:

```tsx
const confirm = useConfirm();
const ok = await confirm({
  title: "Delete this record?",
  body: <>…</>,
  confirmLabel: "Delete record",   // never "OK" — restate the verb
  tone: "danger",
});
```

Requirements:
- The confirm button restates the action's verb. `Confirmation.tsx:16` already
  establishes this rule ("Save changes" → "Changes saved") — follow it.
- Destructive confirm uses `variant="danger"` (outlined red), **not** a red
  fill, so it can't be mistaken for the primary path — see `Button.tsx:14-17`.
- Cancel is focused by default on destructive dialogs.

Replace all three `confirm()` calls (`Records.tsx:128`,
`FlaggedRecords.tsx:53`, `BusinessProfiles.tsx:54`). The archive dialog's
existing explanation text ("Nothing is deleted — all its records, insights and
conversations are kept") is good copy; keep it, it just needs somewhere
readable to live.

**2.2 Add undo to delete.** Extend `ToastProvider` to accept an optional
action:

```tsx
toast("Record deleted", { actionLabel: "Undo", onAction: () => restore(record) });
```

Optimistically remove the row, hold the record in state, and re-POST on undo.
Extend the toast timeout to ~8s when an action is present — 3.2s is not long
enough to read a message and decide.

Note the accessibility change this forces: `Toast.tsx:298` currently uses
`role="status"` on the grounds that toasts are never actionable. A toast with
an Undo button *is* actionable and must be reachable by Tab. Update the
comment when you update the behaviour.

**2.3 Confirm mutations with a toast instead of a bare redirect** — B4.
`"Expense saved"` on navigate away from AddExpense; `"Record kept"` /
`"Record discarded"` on FlaggedRecords; `"12 records imported"` on CSV.

---

### Phase 3 — The three flows UAT scores

This phase is where the study's numbers move. Everything here maps to a
numbered statement in `docs/uat-feedback-form.md`.

**3.1 ScanReceipt — the review step (items 27, 28, 29)**

- **Show the receipt.** Two-column above `md`: the uploaded image on the left
  (object-contain, max-h-[70vh], zoomable via a plain click-to-fullscreen
  `<dialog>`), the extracted-fields form on the right. Stacked below `md` with
  the image collapsible. The user must be able to read the receipt and the
  form at the same time — that is the entire job of this screen.
- **Make the fields visibly provisional.** Every OCR-populated field gets a
  distinct treatment (`bg-tint-info` wash + a small "read from receipt" chip)
  that clears to normal styling the moment the user edits it. A field OCR
  could *not* read shows an explicit empty state — `"Not found — please
  enter"` — never just a blank box. This is the direct fix for item 29.
- **Promote the review instruction.** Replace the 12px tinted line
  (`ScanReceipt.tsx:290-293`) with a `<Callout tone="warn">` above the form:
  *"Check these against your receipt before saving. FinSight often misreads
  creased or faded printing."* The scoring guide already records that OCR
  degrades on real thermal paper — say so.
- **Skeleton the OCR wait.** Render the field shapes immediately with
  `SkeletonLine`, per `Skeleton.tsx`'s stated purpose.
- **Keep the image on "Rescan"** rather than dropping back to an empty file
  input (`ScanReceipt.tsx:362`).

**3.2 ImportCsv — mapping (items 30, 32)**

- **Auto-map on preview.** Case-insensitive match of each CSV header against a
  synonym list (`date|txn date|transaction date`, `description|item|
  particulars|details`, `amount|total|price|cost`, `category|type`). Pre-select
  the match and show `"Matched automatically — change if wrong"` beneath it.
  Manual mapping stays available for everything unmatched.
- **Validate the mapping.** Block submit if one column is mapped twice; show
  the error on the offending field via `Field`'s `error` prop.
- **Show the mapped preview**, not the raw one. After mapping, re-render the
  preview table with FinSight's column names as headers and amounts through
  `<Money>` so the user sees what they are actually about to import.
- **Make the result actionable.** `ImportCsv.tsx:472-517`: run figures through
  `<Money>`, and turn "Flagged as possible duplicates: 3" into a link to
  `/records/flagged`. Use `Celebration` from `Confirmation.tsx` for a clean
  import — `Confirmation.tsx:12` explicitly names CSV import as one of the
  three moments that earns it, and it currently doesn't get it.

**3.3 FlaggedRecords — explain the flag (items 30, 33, 19)**

- Rebuild on `DataTable` (or keep cards but route them through `Panel`), with
  `Alert`'s severity grammar rather than the hand-rolled pills at
  `FlaggedRecords.tsx:98-113`.
- **Say why.** Each flag needs its reason inline:
  - Large expense → *"PHP 8,400 is above your large-expense threshold of PHP
    6,250 (25% of expected monthly expenses)."*
  - Duplicate → show the *other record* — date, description, amount — as a
    linked side-by-side comparison, not `#{duplicateOfRecordId}`.
  - Needs review → state which rule triggered it.
- **Give false alarms a voice.** Item 33 exists because over-flagging is a
  known problem in categories with few records. Add a "This is normal for my
  business" action next to Keep, so dismissing is one click and the study has
  a signal to count.
- Note in a comment that the large-expense threshold is a **placeholder** rule
  (25% of expected monthly expenses, unconfirmed against the manuscript —
  `CLAUDE-CODE-PROMPT.md:§4`). Do not present it as settled fact in the UI copy
  until it is confirmed.

---

### Phase 4 — Records at scale

**4.1 Debounce the search box.** `Records.tsx:121-125` — split `filters` so
`keyword` runs through `useDebounced(keyword, 250)` while the selects fire
immediately. `useDebounced` is already there (`lib/hooks.ts:244`); GlobalSearch
already uses it. This is a five-line fix.

**4.2 Sync filters to the URL.** Write active filters back with
`setSearchParams(..., { replace: true })`. Restores bookmarking, sharing and
back-button behaviour. Guard against the existing read-effect
(`Records.tsx:63-78`) looping.

**4.3 Optimistic delete.** Remove the row immediately, roll back and surface an
error if the request fails. Pairs with the undo toast from 2.2.

**4.4 Drop the celebration probe.** `AddExpense.tsx:51-54` fetches every
expense record after each save. Either have the POST response carry a
`isFirstRecord` flag, or gate the extra fetch behind
`!hasCelebratedFirstRecord(id)` — it already short-circuits on that value one
line later, so the fetch is wasted on every save after the first.

**4.5 Server-side pagination** — *only if* the backend supports it. If
`/records/search` cannot take `page`/`pageSize`, **stop and flag it** rather
than half-implementing. Note the ceiling in a comment and move on; this is the
one item in this document that is not purely frontend.

---

### Phase 5 — Accessibility

**5.1 Skip link.** First focusable element in `AppShell`, visually hidden until
focused, targets `<main id="main-content">`.

**5.2 Route-change handling.** On `location.pathname` change: move focus to
`<main>` (`tabIndex={-1}`), and announce the new page title through a visually
hidden `aria-live="polite"` region. Keep the existing `animate-fade-up`.

**5.3 Label `CategorySelect`.** Accept `id` and `label` props; wire `htmlFor`.
Fixes `AddExpense.tsx:106`.

**5.4 Manage focus in `CategorySelect`'s create mode.** Focus the name input on
entry (it does), and return focus to the select on cancel (it does not).
Announce the created category via toast.

**5.5 Focus-trap the drawer and the quick-add menu.** `useDismiss` handles
outside-click and Escape; add a `useFocusTrap` hook alongside it in
`lib/hooks.ts` for anything modal. The `<dialog>` from Phase 2.1 gets this for
free — reuse it where the surface is genuinely modal.

**5.6 Verify contrast on the two custom-coloured surfaces** — the impact band
chip and the alert severity solids — in all three themes. `lib/chartPalette.ts`
already documents measured ratios; extend that table rather than eyeballing it.

---

### Phase 6 — Trust and comprehension

This phase targets UAT items 19 and 23, the two the scoring guide singles out
as capable of failing the system even when the headline percentages pass.

**6.1 Explain the three setup figures** (`BusinessProfileForm.tsx`) — item 23.
Each gets a `hint` (the mechanism built in Phase 1.1) in plain language, not
accounting language:

- *Available business funds* — "Roughly how much cash the business has to work
  with right now. You'll update this as things change; FinSight doesn't read
  your bank."
- *Expected monthly expenses* — "What a normal month costs you — rent, stock,
  wages, utilities. FinSight uses this to work out how much you need to sell."
- *Operating days* — "How many days a month the business is actually open. Used
  to spread your target across the days you can actually sell."

Add a worked example, e.g. *"PHP 125,000 across 25 operating days = a PHP 5,000
daily target."* The Landing page already demonstrates exactly this arithmetic
with `DEMO_BASE` (`Landing.tsx:22-34`) — reuse the numbers so the explanation
and the demo agree.

**6.2 Label provenance everywhere** — item 19. Three sources, three
treatments, applied consistently:

| Source | Treatment | Already correct at |
|---|---|---|
| Owner-entered | `meta="Owner-entered reference"` | `Dashboard.tsx:201` |
| Computed from records | `"Composed from your records — not AI-written"` | `Dashboard.tsx:237` |
| AI-written | `AiCard` + its footer disclaimer | `components/ui.tsx:145-149` |

Audit every screen against this. A figure whose origin is ambiguous is a
figure the owner has no reason to trust, and item 19 is the statement the
scoring guide calls "the whole system's value."

**6.3 Explain the empty dashboard honestly.** When a business has fewer than
~10 records, the insights are statistically weak — `CLAUDE-CODE-PROMPT.md:§3`
says the Z-score baseline runs until there's enough history. Say so in the UI:
*"Based on 4 records. FinSight gets more accurate as you add more."* Claiming
confidence you don't have is the fastest way to lose item 19.

---

## 5. What NOT to do

- Do not add a component library, a CSS-in-JS layer, or a new icon set.
  `components/icons.tsx` exists.
- Do not convert `DataTable` to a virtualised or headless table library. It is
  ~300 lines, it works, and it is the reason every table in the app looks the
  same.
- Do not "modernise" the colour palette. The teal/amber pairing and its
  contrast ratios are measured, documented, and mirrored by the mobile app.
- Do not add animation beyond the eight keyframes already in
  `tailwind.config.js:234-285`. They cover every transition the app performs.
- Do not delete the long explanatory comments. If you change the behaviour they
  describe, update the comment.
- Do not add a dark-mode `dark:` variant anywhere. The token system exists
  precisely so no call site needs one.
- Do not touch `backend/` or `mobile/` as part of this work, except to flag
  4.5 if `/records/search` can't paginate.

---

## 6. Verification checklist

Run before declaring any phase done.

```bash
cd web
npm run lint        # oxlint
npm run build       # tsc -b && vite build — must pass with no new errors
```

Manual, in **all three themes** (Classic / Light / Dark) and at **320px, 768px
and 1440px**:

- [ ] No literal Tailwind colour introduced: `grep -rnE "bg-(slate|gray|zinc|rose|emerald|indigo|amber)-[0-9]" web/src/`
- [ ] `grep -rn "bg-accent-400" web/src/pages/` → empty
- [ ] `grep -rn "confirm(" web/src/pages/` → only `handleConfirm` / `setConfirm…`
- [ ] `grep -rn "toLocaleString" web/src/` → only `Money.tsx`, `Pagination.tsx`, and AI-context string builders
- [ ] Every form: submit with an invalid field, confirm the error is announced (`role="alert"`) and focus moves to it
- [ ] Tab from page load reaches the skip link first, and it works
- [ ] Every destructive action opens `ConfirmDialog`, and Escape cancels it
- [ ] Delete a record → toast appears with Undo → Undo restores it
- [ ] Records search: type 8 characters fast, confirm **one** network request in DevTools
- [ ] Apply filters, copy the URL, open in a new tab → same view
- [ ] ScanReceipt: the receipt image and the extracted fields are visible simultaneously
- [ ] ImportCsv: a file with headers `date,description,amount,category` auto-maps all four
- [ ] FlaggedRecords: every flag states the reason and, for duplicates, shows the other record
- [ ] `prefers-reduced-motion: reduce` → no shimmer, no pop, no meter fill; everything still legible
- [ ] Zoom to 200% → no horizontal page scroll at any breakpoint

---

## 7. Suggested commit sequence

```
refactor(web): add Field/TextInput/SelectInput/MoneyInput/FileInput primitives
refactor(web): replace hand-rolled primary buttons with <Button variant="primary">
refactor(web): migrate all forms to the Field primitive
refactor(web): route FlaggedRecords and SpendingImpact through Panel/Pill/Money
feat(web): add ConfirmDialog and replace native confirm() calls
feat(web): add undo to record deletion via the toast
feat(records): debounce search and sync filters to the URL
feat(records): show the receipt image beside the extracted fields
feat(records): auto-map CSV columns and validate the mapping
feat(records): explain why each record was flagged
feat(web): add skip link, route announcement and focus management
feat(web): explain the three business-profile setup figures
```

---

## 8. Priority if time is short

The project is a capstone with a UAT study attached. If you can only do part of
this, the ranking by effect on the study's measured outcomes is:

1. **Phase 1** — everything else is cheaper afterwards, and it removes the
   visible inconsistency between the demo screens and the working screens.
2. **Phase 3** — directly moves UAT items 27–32, the whole of Experiment 3.
3. **Phase 6** — items 19 and 23, which the scoring guide says can fail the
   system on their own.
4. **Phase 2** — the credibility of destructive actions.
5. **Phase 5** — accessibility.
6. **Phase 4** — real, but it will not show up in a 20-participant UAT with
   small datasets.
