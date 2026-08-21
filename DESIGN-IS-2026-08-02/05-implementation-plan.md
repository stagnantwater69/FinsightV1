# FinSight Mobile — Refine Implementation Plan

Derived from the Rams audit in this directory (20/30, verdict REFINE). Seven phases, each self-contained and executable in a fresh session.

**Golden rule for every phase:** this is a REFINE pass. Copy existing patterns from the citations given; do not invent new abstractions. Exactly one new abstraction is authorized in this entire plan (Phase 2's chip primitives). If a fix seems to need another, stop and flag it.

---

## Phase 0 — Verified facts & allowed APIs

Everything below was read from source or installed type definitions during discovery. **Do not re-derive these from memory; do not assume APIs beyond this list.**

### Design tokens — `mobile/src/theme/tokens.ts`
```
brand 50–950 (500 = #149e8d)   accent 50–900 (400 = #f5a524)
ACCENT = { fill: accent400, fillStrong: accent500, onFill: "#1a2022", text: accent700, surface: accent50 }
ink 50–900   paper { DEFAULT #ffffff, 50, 100, 200 }
status { good warning serious critical }   statusText { same, darkened — text-safe }
categorical[8]   font { sans sansMedium sansSemibold display displayBold mono monoMedium monoSemibold }
radius { sm:8 md:12 lg:16 xl:20 full:999 }   space { xs:4 sm:8 md:12 lg:16 xl:20 xxl:24 }   TAP = 44
```
Import style is direct named import, no barrel:
`import { ACCENT, brand, font, ink, paper, radius, space, statusText, TAP } from "../theme/tokens";`

### `ui.tsx` primitive kit (611 lines) — exact exports
`T` (37–48), `Money` (57–83), `Button` (89–142), `Card` (146–166), `StatTile` (170–190), `Alert` (206–240), `AlertBadge` (242–251), `Pill` (255–303, **dead**), `ExecutiveSummaryCard` (307–344, **dead**), `EmptyState` (349–374), `SetupProgress` (377–403), `Callout` (422–446), `ErrorNote` (448–454), `Screen` (465–486), `ScreenHeader` (497–528), `Divider` (531–533, **dead**).

```ts
// T variants — ui.tsx:29-35
title:   { fontFamily: font.displayBold, fontSize: 20, color: brand[900] }
heading: { fontFamily: font.display,     fontSize: 15, color: ink[700] }
body:    { fontFamily: font.sans,        fontSize: 15, color: ink[700], lineHeight: 22 }
label:   { fontFamily: font.sansMedium,  fontSize: 13, color: ink[500] }
caption: { fontFamily: font.sans,        fontSize: 12, color: ink[400] }  // ← the contrast bug
```
`T` has **no** `weight`/`color` prop of its own — it spreads RN `TextProps` and callers override via `style`.

```ts
// Button — ui.tsx:89-142
variant: "primary" | "brand" | "secondary" | "ghost" | "danger"   // default "brand"
bg:  primary ACCENT.fill | brand brand[600] | secondary paper.DEFAULT | ghost transparent | danger paper.DEFAULT
fg:  primary ACCENT.onFill | brand #ffffff | secondary ink[700] | ghost ink[500] | danger #b91c1c
Pressable + accessibilityRole="button" (125) + accessibilityState={{disabled}} (126)
style-as-function of `pressed`: opacity disabled||loading ? 0.6 : pressed ? 0.85 : 1   (129-133)
styles.button (536-545): minHeight TAP, paddingHorizontal space.lg, borderRadius radius.md,
                         borderWidth 1, row, gap space.sm, centered
```

```ts
// Card — ui.tsx:146-166, styles at 560-571
backgroundColor paper.DEFAULT, borderRadius radius.lg, borderWidth 1,
borderColor paper[200], padding space.lg,
shadowColor ink[900], shadowOffset {0,1}, shadowOpacity 0.04, shadowRadius 3, elevation 1
```
**The shadow system is exactly two declarations app-wide** (`styles.card`, and dead `ExecutiveSummaryCard` at 324–328). Convention comment at ui.tsx:546–559: always set both iOS and Android props. Do not add a third shadow style.

**Style convention:** one `StyleSheet.create` block at the bottom (535–611) for reusable shells; inline object literals for per-variant/dynamic styling; composed as `[styles.x, cond && {...}, style]`.

### `Field` — NOT in ui.tsx
Lives at **`mobile/src/screens/AuthScreens.tsx:13-46`**, imported cross-file by `BusinessScreens.tsx:5` and `RecordsScreens.tsx:15`.
```ts
export function Field({ label, value, onChangeText, ...rest }:
  { label: string; value: string; onChangeText: (v: string) => void }
  & React.ComponentProps<typeof TextInput>)
```
Renders `View(marginBottom space.md)` → `T variant="label"` → `TextInput` with `{...rest}` spread **last**.
Consequences, both load-bearing:
- `returnKeyType` / `onSubmitEditing` / `blurOnSubmit` **already pass through** — no change needed to use them.
- `ref` does **not** pass through — it is a plain function component. **Zero `forwardRef` exists anywhere in `mobile/src/`** (verified). Ref-based focus chaining requires converting `Field` to `forwardRef` first.
- A caller-passed `style` **replaces** the input style rather than merging — do not pass `style` to `Field` without checking this.

### Test & verification capability — READ THIS BEFORE PLANNING ANY VERIFICATION
- Commands: **`npm test`** (`vitest run`) and **`npm run typecheck`** (`tsc --noEmit`). **No lint script exists in `mobile/`.**
- devDependencies are only `@types/node`, `@types/react`, `typescript ~6.0.3`, `vitest ^4.1.10`.
- **There is NO component-rendering capability.** No `@testing-library/react-native`, no `react-test-renderer`, no `jest`, no `jsdom`. Verified.
- Existing tests (all pure-logic or static source scans): `tests/money.test.ts` (71), `tests/recordUpdate.test.ts` (87), `tests/receiptConfirm.test.ts` (216), `tests/categorySuggestion.test.ts` (102), `tests/navigationTargets.test.ts` (61).
- **`tests/navigationTargets.test.ts` is the precedent to copy for verifying UI refactors** — it `readFileSync`/`readdirSync`s over `src/screens` and asserts a property of the source text (every `navigate("X")` target is registered). Several phases below specify static-scan tests in exactly this style.
- Repo doctrine (from commit `dc0df25`): *"Logic that decides what gets saved has to be testable on its own"* — extract logic to `src/lib/` to make it testable.
- **Do not propose adding a component-test framework.** That is out of scope for this refine pass.

### React Native 0.86 — reduced-motion API (from installed typedefs)
`mobile/node_modules/react-native/types_generated/Libraries/Components/AccessibilityInfo/AccessibilityInfo.d.ts`
```ts
isReduceMotionEnabled(): Promise<boolean>;                                    // :80
addEventListener<K>(eventName: K, handler): EventSubscription;               // :180
// event name literal: "reduceMotionChanged", payload [boolean]              // :32,36,41
// EventSubscription.remove(): void  — the correct cleanup                   // EventEmitter.d.ts:14-15
```

**Anti-patterns — APIs that DO NOT exist in this project. Using any of these is a bug:**
1. `useReducedMotion()` from `react-native` core — does not exist in 0.86.
2. `useReducedMotion()` from `react-native-reanimated` — **reanimated is not installed**; do not add it.
3. CSS `prefers-reduced-motion` — meaningless in RN.
4. `AccessibilityInfo.removeEventListener(...)` — legacy; use `subscription.remove()`.
5. Assuming `Animated.loop`/`timing` self-disables under reduce-motion — it does not. Gating is manual.

### Haptics — `mobile/src/lib/haptics.ts`
`tapped()` selection · `pressed()` impact-light (**never called anywhere**) · `succeeded()` notification-success · `warned()` · `failed()` · `committed()` impact-medium. No-ops off iOS/Android.

### No toast system exists
Verified: no toast/snackbar/overlay component anywhere in `mobile/src/components/`. Acknowledged in-code at `RecordsScreens.tsx:1875`: *"Web offers an undo toast instead; mobile has no toast system yet."*

---

## Phase 1 — Token hygiene & dead-code removal

Smallest, safest, highest-confidence changes. Everything here is confined to three files and unblocks later phases by reducing noise.

### 1a. Fix the `caption` contrast failure
**File:** `mobile/src/components/ui.tsx:34`
**Change:** `color: ink[400]` → `color: ink[500]`
**Why:** `ink[400]` is 3.36:1 — below WCAG AA's 4.5:1 for body text. `tokens.ts:65` explicitly flags it *"decorative / placeholder only — 3.36:1, not for body text"*, yet it is the default for the `caption` variant, used **95 times** (verified count) for dates, hints, and chart axis labels — all functional text. `ink[500]` is 5.39:1 against white, 5.28:1 against `paper[50]`. Passes AA.
**Blast radius:** all 95 caption sites get one step darker. This is intended.
**Do NOT:** add a new "decorative" text variant. Placeholder text is a separate concern already handled correctly by the 7 `placeholderTextColor={ink[400]}` sites — leave those alone; `ink[400]` remains legitimate there.

### 1b. Remove the RecoveryMeter token drift
**File:** `mobile/src/components/RecoveryMeter.tsx:81`
**Change:** hardcoded `#e8efed` → `paper[200]` (import from `../theme/tokens`; the value is byte-identical, `tokens.ts:77`).

### 1c. Delete confirmed-dead code
All five verified as having **zero call-sites** across `mobile/src/` (grep-confirmed twice, independently):

| Symbol | Location | Action |
|---|---|---|
| `ExecutiveSummaryCard` | `ui.tsx:307-344` | Delete |
| `Pill` | `ui.tsx:255-303` | Delete |
| `Divider` | `ui.tsx:531-533` | Delete |
| `SeriesDot` | `charts.tsx:421-432` | Delete |
| `HeroFigure` | `charts.tsx:389-418` | Delete |

Deleting `ExecutiveSummaryCard` also removes the second of only two shadow declarations in the app, leaving `styles.card` as the single shadow definition — a net simplification. Note its copy (`"Composed from your records — not AI-written"`) is a good honesty pattern; it is preserved in the audit record and can be revived from git if that card is ever built for real.

### 1d. Resolve unused props — decide ship-or-delete, no third option
| Prop | Location | Recommendation |
|---|---|---|
| `Alert.action` | `ui.tsx:211,217,235` — rendered but never passed by any of 6 call-sites | **Delete.** `EmptyState.action` already covers the "alert with an action" need and *is* used (2 sites). |
| `Money.bare`, `Money.decimals` | `ui.tsx:59-60`, forwarded to `formatMoney` | **Keep both.** Unlike the others these are not dead weight in the UI layer — `formatMoney(value, {decimals, bare})` in `src/lib/money.ts:10-18` is covered by `tests/money.test.ts`, and the props are the only way to reach that tested behavior. Deleting them would orphan tested logic. Add a one-line comment noting they are intentionally-unused public API. |
| `RecoveryMeter.compact` | `RecoveryMeter.tsx:18`, both callers omit it | **Delete** the prop and the dead `!compact` branch at `:80`. |

### Verification
```bash
cd mobile && npm run typecheck && npm test
grep -rn "ExecutiveSummaryCard\|SeriesDot\|HeroFigure" src/ | grep -v "^$"   # must be empty
grep -rn "#e8efed" src/                                                      # must be empty
grep -n "caption:" src/components/ui.tsx                                     # must show ink[500]
```
`Pill` and `Divider` are common words — grep with `\bPill\b` / `\bDivider\b` to avoid false positives from `CategoryPicker`, etc.

### Anti-patterns
- Do not "improve" any other token value while in `tokens.ts` — palette values are out of scope; only usage discipline is in scope.
- Do not delete `pressed()` from `haptics.ts` even though it is uncalled — it is a coherent part of a small public API surface and Phase 2 may use it.

---

## Phase 2 — The one authorized new abstraction: chip primitives

This is the plan's core move and its only sanctioned new abstraction. Discovery found **ten** selection-control implementations across five distinct visual treatments. The goal is to collapse five treatments into **two**.

### The evidence (all verified, line numbers current)

**Group A — already pixel-identical (4 sites).** `minHeight: TAP-10` (34), `paddingHorizontal: space.md`, `borderRadius: radius.full`, `borderWidth: 1`; selected `brand[600]` fill + `brand[600]` border + `#fff` text; unselected `paper.DEFAULT` + `ink[200]` border + `ink[700]` text; `fontSize: 12`.
- `FilterChip` — `RecordsScreens.tsx:168-195`
- `CategoryChips` — `RecordsScreens.tsx:537-572`
- CSV header chips — `RecordsScreens.tsx:1740-1763`
- `DateRangeChips` — `DateField.tsx:165-217`

**Group A′ — same treatment, off-by-one sizing (1 site).** `CategoryPicker` chips, `RecordsScreens.tsx:651-669`: `minHeight: TAP-8` (36), `fontSize: 13`.

**Group B — outlined rectangles (2 sites).** `brand[100]` border, `ink[600]` unselected text.
- `InsightTabs` — `InsightsScreens.tsx:14-44`: `flex: 1` equal-width, `radius.md`, no horizontal padding, selection derived from **navigation route**, not state.
- Insights period toggle — `InsightsScreens.tsx:89-107`: `radius.sm`, `minHeight: TAP-8`.

**Group C — track-backed segmented control (1 site).** Dashboard `PERIODS`, `DashboardScreen.tsx:88-112`: `paper[100]` track container with `padding: 3`, **no border at all**, unselected background `"transparent"`, fires `haptics.tapped()`.

**Leave alone — do not migrate (documented decisions, not oversights):**
- `GapOption` — `RecordsScreens.tsx:580-612`. Uses `accessibilityRole="radio"` and `brand[50]` selected fill. It is a radio list with descriptive text, semantically a different control. Out of scope.
- `AskFinSight` starter chips — `AskFinSight.tsx:307-320`. These are *suggestions*, not a selection set — they have no selected state. They get an `accessibilityRole` in Phase 5 but keep their own styling.

### What to build — in `ui.tsx`, following the file's existing conventions

Two components. Model their structure on `Button` (`ui.tsx:89-142`): `Pressable` root, `accessibilityRole`, `accessibilityState`, style-as-function of `pressed`, `StyleSheet.create` shell at the bottom + inline dynamic overrides.

```ts
// 1. SelectChip — replaces Groups A and A′ (5 sites)
export function SelectChip({ label, selected, onPress, accessibilityLabel, disabled, haptic = true }: {
  label: string; selected: boolean; onPress: () => void;
  accessibilityLabel?: string; disabled?: boolean; haptic?: boolean;
})
// Style: Group A's values verbatim (TAP-10, space.md, radius.full, borderWidth 1,
//        brand[600]/#fff selected, paper.DEFAULT/ink[200]/ink[700] unselected, fontSize 12)
// accessibilityRole="button", accessibilityState={{ selected, disabled }}
// Add what all 10 sites currently lack: pressed feedback (opacity 0.85, copying Button:131)

// 2. SegmentedControl — replaces Groups B and C (3 sites)
export function SegmentedControl<T extends string | number>({ options, value, onChange, accessibilityLabel }: {
  options: { label: string; value: T }[]; value: T;
  onChange: (v: T) => void; accessibilityLabel?: string;
})
// Style: normalize onto Group C's track treatment — paper[100] track, padding 3,
//        radius.md outer / radius.sm inner, no borders, brand[600] selected fill,
//        transparent unselected, #fff / ink[600] text, fontSize 13, each segment flex:1
// Fires haptics.tapped() on change (Group C already does; Groups B do not — this is the normalization)
```

**Why normalize Group B onto Group C's track treatment:** the track-backed form is the platform-standard segmented control (iOS HIG), it is already what the Dashboard uses, and it removes the `brand[100]`-border treatment that exists nowhere else in the app. Three period/tab switchers currently look like three different controls; after this they look like one.

**Normalization decisions to apply deliberately (each is an intentional visual change, not a bug):**
- Group A′ loses its 2px height and 1px font-size difference — it becomes identical to Group A.
- Groups B gain the track background and lose their borders.
- All chips gain press feedback (currently **zero of ten** have any).
- All chips gain consistent `accessibilityRole` + `accessibilityState` (currently the Insights period toggle and CSV chips have **none**).

### Migration order — one commit per step, typecheck between each
1. Build both primitives in `ui.tsx`. Typecheck.
2. `DateRangeChips` (`DateField.tsx:165-217`) — smallest, self-contained, already has role+state+haptics. Proves the primitive.
3. `FilterChip` (`RecordsScreens.tsx:168-195`) — delete the local component, use `SelectChip` at its call-sites (`:412,418,427,433`). **Preserve the caller-authored "Any" chip and toggle-to-clear behavior** (`categoryId === c.id ? null : c.id`) — that logic stays at the call-site; `SelectChip` is presentational.
4. `CategoryChips` (`:537-572`) — **must keep** its unique per-item `accessibilityLabel={`${c.name}, category for ${label}`}` (`:555`); pass it through the new `accessibilityLabel` prop.
5. CSV header chips (`:1740-1763`) — N independent single-selects sharing one option list. Keep that structure; only the chip rendering changes. These currently have zero a11y props — they gain them here.
6. `CategoryPicker` chips (`:651-669`) — **do not touch** the adjacent create-new-category TextInput + "Add" Button block (`:678-696`) or the empty-state branch (`:671-677`). Only the chip row changes.
7. `SegmentedControl`: Dashboard `PERIODS` (`DashboardScreen.tsx:88-112`) first (it already matches the target treatment), then Insights period (`InsightsScreens.tsx:89-107`), then `InsightTabs` (`InsightsScreens.tsx:14-44`).
8. `InsightTabs` is the trickiest: its "value" is the current **route name** and `onChange` is `navigation.navigate(t.key)`. Adapt at the call-site — pass `value={activeRouteName}` and `onChange={(k) => navigation.navigate(k)}`. Do not build route-awareness into the primitive.

### Verification
```bash
cd mobile && npm run typecheck && npm test
# no ad-hoc chip styling should remain outside ui.tsx:
grep -rn "radius.full" src/ --include=*.tsx | grep -v "components/ui.tsx"
# expect only genuinely non-chip uses (badges/avatars) — review each hit by hand
grep -rn "TAP - 10\|TAP-10\|TAP - 8\|TAP-8" src/ | grep -v "components/ui.tsx"   # should be empty
```
Add a static-scan test in the style of `tests/navigationTargets.test.ts`:
`tests/chipConsistency.test.ts` — read every file in `src/screens` + `src/components` except `ui.tsx`, assert none contains `borderRadius: radius.full` paired with `brand[600]` (i.e. no hand-rolled selected-chip styling has crept back in). This is the durable guard against re-sprawl.

**Live-device check required before ship:** chip wrapping behavior at small widths and with long Filipino category names cannot be verified from source. Flag for manual QA.

### Anti-patterns
- Do not add `icon`, `badge`, `count`, or `colorDot` props. **Zero of the ten current chips render any of these** — adding them is speculative API.
- Do not build a `ChipGroup` container component. Containers vary legitimately (wrap vs. row vs. shared-row-with-a-button) and are two lines at each call-site.
- Do not migrate `GapOption` or the AskFinSight starter chips.
- If migrating a call-site requires changing navigation structure or screen state shape, **stop and flag** — that is structural redesign, explicitly out of scope.

---

## Phase 3 — What the user is told: plain language & success feedback

### 3a. Plain-language the four flagship terms
The audit's #4 (understandable) scored 1/3 largely because FinSight's most distinctive concepts carry its least explicable labels. Prefer **adding a plain-language subtitle** over renaming, so existing users aren't disoriented and the app's own vocabulary survives.

| Term | Location | Approach |
|---|---|---|
| "Recovery target" | `RecoveryMeter.tsx` (heading), `DashboardScreen.tsx:214` | Keep name, add one-line subtitle: what must still be earned this month to cover expected expenses. |
| "Adjusted daily target" | `RecoveryMeter.tsx:69` | Keep name, add subtitle explaining it is spread across remaining *operating* days, not calendar days. |
| "Sales reference" | `DashboardScreen.tsx:149`, `RecordsScreens.tsx:799` | Clarify this is a recorded sale for tracking, not a customer receipt. |
| "Large-expense threshold (%)" | `BusinessScreens.tsx:274` | Add helper text under the field: expenses this much above your usual get flagged for review. |

Use the existing `T variant="caption"` (now `ink[500]` after Phase 1) or `Callout` (`ui.tsx:422-446`) — do not invent a new helper-text component.

**Copy constraint — non-negotiable.** Principle #6 (honest) scored 3/3 and must stay there. New copy must be plain and non-inflationary. Before committing:
```bash
grep -rniE "powerful|smart|instantly|seamless|effortless|magic|AI-powered" src/
```
Any new hit is a regression. Note the existing legitimate uses of "AI" are all *disclaiming* ("interpreted from the photo by AI", "not AI-written") — preserve that voice exactly.

### 3b. Success feedback for the four silent completions
Discovery pinpointed exactly where success feedback is missing: four flows fire a haptic and navigate away, leaving no visual confirmation.

| Site | Flow | Current |
|---|---|---|
| `RecordsScreens.tsx:316` | Mark "Not a Duplicate" | `haptics.succeeded()` only, stays on screen |
| `RecordsScreens.tsx:730` | Add expense | `haptics.succeeded()` → `navigation.goBack()` |
| `RecordsScreens.tsx:1084` | Confirm scanned receipt | `haptics.succeeded()` → `navigation.goBack()` |
| `RecordsScreens.tsx:1863` | Save edited record | `haptics.succeeded()` → `navigation.goBack()` |

Haptics are silent for anyone with system haptics off, and invisible to everyone — this is why #8 (thorough) scored 1/3.

**The approach — and the honest tension.** There is no toast system, and the plan forbids inventing abstractions. But the three existing success patterns are all *view swaps on the screen you're already on* (`AuthScreens.tsx:189-195`, `RecordsScreens.tsx:1483-1516`, `:1711-1731`), and none of them work when the flow's final act is to navigate away.

**Recommended minimum:** pass a confirmation message through the existing navigation as a route param, and render it on the destination using the **existing `Callout` component**. Roughly 20 lines in one place, no new visual language, no toast infrastructure:
- On success: `navigation.navigate("Records", { flash: "Expense saved" })` instead of bare `goBack()`.
- On the destination list screen: read the param, render `<Callout tone="info">` above the list, clear it after ~4s with a `setTimeout` in a `useEffect` (clean up the timer on unmount).
- Site `:316` stays on-screen, so it needs no navigation param — render the same `Callout` inline.

Extract the param-read + auto-clear into `src/lib/` if it is used more than twice, per repo doctrine (`dc0df25`) — that also makes it unit-testable, which UI code here is not.

**Decision point for the implementer:** if a reviewer would rather build a real toast component, that is a defensible call — but it is a *new abstraction* and must be raised explicitly rather than slipped in. The in-code note at `RecordsScreens.tsx:1875` ("mobile has no toast system yet") suggests it is already on someone's mind. Do not decide this silently.

### Verification
```bash
cd mobile && npm run typecheck && npm test
grep -rniE "powerful|smart|instantly|seamless|effortless|magic" src/     # must be empty
grep -n "haptics.succeeded" src/screens/RecordsScreens.tsx                # each hit needs a visual sibling
```
Add `tests/successFeedback.test.ts` (static scan, `navigationTargets` style): assert every `haptics.succeeded()` call in `src/screens` has either a `flash:` navigation param or a `Callout` within N lines. This encodes the rule so it cannot silently regress.

**Live-device check required:** haptic-plus-visual timing and `Callout` dismissal feel.

---

## Phase 4 — Focus states & form keyboard flow

### 4a. Focus state on text inputs — the systemic gap
**Zero `onFocus` handling exists anywhere in the app** (verified). Every `TextInput` keeps a static `ink[200]` border whether focused or not. This is half of why #8 scored 1/3.

**Fix at the single choke point:** `Field` (`AuthScreens.tsx:13-46`) is used by every form in the app. Add local `focused` state, and on focus swap the border to `brand[600]` (matching `Button`'s brand fill) with `borderWidth` held at 1 so nothing reflows.

**Note on `Field`'s location:** it is an odd place for a shared primitive — it lives in a screen file and is imported by two other screen files. **Do not move it to `ui.tsx` in this phase.** That is a mechanical relocation touching three files' imports, and mixing it into a behavior change makes the diff hard to review. Flag it as a follow-up.

Also check the raw `TextInput`s that bypass `Field`: `RecordsScreens.tsx:352` (filter keyword), `:679` (new category name), `InsightsScreens.tsx:270`, `AskFinSight.tsx:348` (chat composer). Apply the same treatment or leave deliberately — but decide, don't skip.

### 4b. Keyboard "next" ordering
**Zero `returnKeyType`/`onSubmitEditing`/`blurOnSubmit` exist in any multi-field form** (the only `onSubmitEditing` app-wide is `InsightsScreens.tsx:272`, single-field).

**Prerequisite:** `Field` must become a `forwardRef` component to allow `ref`-based focus chaining. There is currently **no `forwardRef` anywhere in `mobile/src/`** — this is the first. Note that `{...rest}` already forwards `returnKeyType`/`onSubmitEditing`, so only `ref` needs the new plumbing.

Forms to wire, with verified field order (T = focusable text input; P = picker/pressable, **cannot** take `returnKeyType`):

| Form | Location | Text-input chain |
|---|---|---|
| Login | `AuthScreens.tsx:76-114` | Email → Password → submit |
| Register | `AuthScreens.tsx:119-166` | First → Last → Email → Password → submit |
| Business profile | `BusinessScreens.tsx:183-283` | Name → Type → Funds → Monthly expenses → Operating days → Threshold% → submit |
| Profile | `BusinessScreens.tsx:289-380` | First → Last → Phone → submit |
| Security | `BusinessScreens.tsx:366-375` | Current pw → New pw → Confirm pw → submit |
| Add expense | `RecordsScreens.tsx:703-760` | (Category P, Date P) → Description → Vendor → Amount → submit |
| Add sales | `RecordsScreens.tsx:765-810` | (Date P) → Description → Amount → submit |
| Edit record | `RecordsScreens.tsx:1798-1957` | (Category P, Date P) → Description → Vendor → Amount → submit |
| Scan receipt review | `RecordsScreens.tsx:1269-1281` | (Category P, Date P) → Description → Vendor → Amount |

Pattern: `returnKeyType="next"` + `onSubmitEditing={() => nextRef.current?.focus()}` on all but the last; `returnKeyType="done"` + submit handler on the last. Pickers break the chain — chain across them to the next text input.

**While here, fix missing autofill metadata:** Register's Email and Password fields (`AuthScreens.tsx:145-160`) have no `autoComplete`, though Login's equivalents do. Add `autoComplete="email"` / `autoComplete="new-password"` and matching `textContentType`.

### 4c. `KeyboardAvoidingView` gap
**Only `AuthScreens.tsx` uses `KeyboardAvoidingView`** (`AuthShell`, `:50`). Every other form — Business profile (6 fields), Profile, Security, Add expense, Add sales, Edit record, Scan receipt review — is in a bare `ScrollView` with none. Focus-chaining into a field hidden behind the keyboard is worse than no chaining, so this must land **with** 4b, not after.

Copy the `AuthShell` pattern (`AuthScreens.tsx:47-74`) rather than inventing a wrapper.

### Verification
```bash
cd mobile && npm run typecheck && npm test
grep -rn "returnKeyType" src/screens/ | wc -l          # expect ≥ 25
grep -rn "onFocus" src/ | wc -l                        # expect ≥ 1 (Field), was 0
grep -rn "KeyboardAvoidingView" src/screens/ | wc -l   # expect ≥ 4, was 1
```
**Live-device check required before ship:** keyboard avoidance and focus-scroll behavior genuinely cannot be verified from source, and differ between iOS and Android. This phase carries the highest "looks right in code, wrong on device" risk in the plan.

### Anti-patterns
- Do not relocate `Field` to `ui.tsx` in this phase (see 4a).
- Do not add a form library. Nine forms with local `useState` is not a problem this pass is solving.
- Do not add focus rings via shadow — the app has exactly one shadow declaration and it should stay that way. Border color only.

---

## Phase 5 — Accessibility roles & labels

Small, mechanical, high-value. 26 of ~91 interactive sites currently declare a role explicitly (many others inherit correctly from `Button`/`SelectChip`).

### 5a. Add missing `accessibilityRole`
Six sites verified missing — note two were **not** in the original audit and were found during discovery:

| Site | What it is |
|---|---|
| `DashboardScreen.tsx:155` | `Pressable` wrapping a `Card`, navigates to FlaggedRecords |
| `InsightsScreens.tsx:90-107` | Period toggle — **resolved by Phase 2** if `SegmentedControl` landed |
| `InsightsScreens.tsx:288-300` | "Check" button (Spending Impact) |
| `RecordsScreens.tsx:1745-1760` | CSV mapping chips — **resolved by Phase 2** |
| `AskFinSight.tsx:307-320` | Starter-prompt chips — *newly found, not in audit* |
| `RecordsScreens.tsx:112` | `RecordCard` wrapper Pressable — *newly found, not in audit* |

Re-check each after Phase 2; only the unresolved ones need manual edits.

### 5b. Section headers for screen-reader navigation
**No `accessibilityRole="header"` exists anywhere** (0 hits). Screen-reader users have no way to jump between sections and must swipe linearly through long records/alerts lists. Add it to section titles in `ScreenHeader` (`ui.tsx:497-528`), `ChartFrame` titles (`charts.tsx:46`), and card headings. Fixing it inside `ScreenHeader` covers most screens in one edit.

### 5c. Image label
`PhotoUpload.tsx:87` is the **only** `<Image>` in the app. It is generic — a business logo *or* a profile photo depending on caller (`BusinessScreens.tsx:244` passes `label="Business logo"`, `:348` passes `label="Profile photo"`). The `label` prop is already used for the adjacent Pressable at `:98`, so derive from it: `accessibilityLabel={label}`. It is never a receipt photo.

### 5d. Swipe-action fallback — mostly a non-issue, verify before building
Discovery answered the audit's open question:
- **Delete already has a fallback** — tapping a record opens `EditRecordScreen`, which has a "Delete record" button (`RecordsScreens.tsx:1954`). **No new UI needed.**
- **Resolve is swipe-only from the Records list**, but reachable via `FlaggedRecordsScreen`'s "Looks right — mark reviewed" (`:2015`) — for records the `/records/flagged` endpoint returns.

**Recommendation: add a Resolve control to `EditRecordScreen`** (next to the existing Delete button) so both swipe actions have a tap-reachable equivalent from the same place. This is a one-button addition, not new infrastructure.

Also note: `RecordsScreens.tsx:28` imports the **legacy** `Swipeable` from `react-native-gesture-handler@2.32.0`, which is deprecated in favor of `ReanimatedSwipeable`. **Do not migrate it in this pass** — reanimated is not installed and adding it is a large native dependency. Log it as tech debt.

### Verification
```bash
cd mobile && npm run typecheck && npm test
grep -rn "accessibilityRole" src/ | wc -l                    # expect meaningful increase from 26
grep -rn 'accessibilityRole="header"' src/ | wc -l           # expect > 0, was 0
grep -rn "<Pressable" src/ -A7 | grep -c "accessibilityRole" # compare against 31 total Pressables
```
**Live-device check required:** actual VoiceOver/TalkBack traversal. Static analysis proves props exist, not that the experience is coherent.

---

## Phase 6 — Motion & startup

Lowest visual risk, highest behavioral risk. Sequenced last deliberately so it cannot destabilize the visual work.

### 6a. Respect reduced-motion
No reduced-motion handling exists anywhere (0 matches). Two animation sites to gate:
- `Skeleton.tsx:18-35` — infinite `Animated.loop` pulsing opacity 0.3↔0.7. Runs continuously while any skeleton is mounted. Consumers: `SkeletonCard` (`:53-73`), `SkeletonDashboard` (`:75-87`), `SkeletonList` (`:89-110`).
- `AskFinSight.tsx:103-114` (`Animated.parallel` of two timings, 260ms open / 200ms close) and `:153` (`Animated.spring` snap-back).

Use only the verified API (Phase 0): `AccessibilityInfo.isReduceMotionEnabled()` for initial state, `addEventListener("reduceMotionChanged", …)` for live changes, `subscription.remove()` for cleanup. **Re-read the Phase 0 anti-pattern list before writing this — four plausible-sounding APIs do not exist here.**

Extract to `src/lib/useReducedMotion.ts` — one hook, used twice, and per repo doctrine it lands in `src/lib/` where it is **unit-testable** (mock `AccessibilityInfo`). This is a genuine exception to the no-new-abstractions rule: it is required by the platform API shape, not a stylistic choice.

Reduced-motion behavior: skeleton renders static at a fixed mid-opacity; the AskFinSight sheet appears without animating (set the final value directly rather than animating to it).

### 6b. Parallelize the bootstrap chain
Discovery established the **true** dependency graph — this differs from what the audit assumed:

```
[supabase session]
   → parallel( /auth/me , /business-profiles )      ← currently sequential, needlessly
   → parallel( /records/categories , /dashboard/summary )   ← both need only businessProfileId
```

Proof `/business-profiles` does **not** depend on `/auth/me`'s response: `BusinessProfileContext.tsx:37-46` calls `api.get("/business-profiles")` with **no arguments and no query params**; the server derives the user from the token (`backend/src/routes/businessProfile.routes.ts:9` `requireAuth`, `businessProfile.controller.ts:42` uses `req.user!.id`). The `user?.id` in the effect dependency (`:57`) is a re-run trigger, not a data input.

Genuinely sequential (do not attempt to parallelize): `/records/categories` and `/dashboard/summary` both require `businessProfileId`, which only exists after `/business-profiles` resolves (`BusinessProfileContext.tsx:60-64`, `DashboardScreen.tsx:35`; server-side both are required positive ints).

Parallelizing is **safe**: `api.ts:23-27` calls `supabase.auth.getSession()` independently per request, supabase-js caches the session in memory after cold start, and `autoRefreshToken` is concurrency-safe.

**⚠ The complication the audit missed — read before starting.** This is not a `Promise.all` swap. `App.tsx:287-290` mounts `BusinessProfileProvider` **only when `profile` is truthy**, so the gating is *structural*, not merely temporal. Removing two round-trips requires either mounting the provider earlier and letting it handle a null profile, or hoisting both fetches to a shared bootstrap. **This is the single riskiest change in the plan** — it touches auth. If it starts requiring changes to navigation structure, **stop and flag**; shipping Phases 1–5 without 6b is a perfectly good outcome.

### 6c. Startup polish — optional
`App.tsx:296-322` gates all rendering behind `Font.loadAsync` (8 faces) with a bare `ActivityIndicator`. `expo-splash-screen` is declared as a plugin (`app.config.ts:59`) but `preventAutoHideAsync`/`hideAsync` are **never called** — so users see the native splash, then a second unbranded spinner. Wiring the imperative API removes the double-flash. Font loading is fully independent of the network chain and can run concurrently with it.

### Verification
```bash
cd mobile && npm run typecheck && npm test
grep -rn "isReduceMotionEnabled" src/ | wc -l    # expect > 0, was 0
grep -rn "useReducedMotion" src/lib/             # the new hook
grep -rn "reanimated" package.json               # must remain absent
```
Add `tests/useReducedMotion.test.ts` — mock `AccessibilityInfo`, assert initial read, event-driven update, and `.remove()` cleanup on unmount.

**Live-device check required (mandatory for this phase):** toggle Reduce Motion in iOS/Android system settings and confirm both animation sites respond. Cold-start timing improvement must be measured on device, not inferred. If 6b ships, re-test login, logout, token refresh, and first-run-with-no-business-profile.

---

## Phase 7 — Final verification & regression

### Regression checklist for the three principles that scored 3/3
These are the "Keep" items. Each must still hold.

**#2 Useful (3/3)**
- [ ] Dashboard still fires exactly **one** API call for its own render — `DashboardScreen.tsx:38-41`, `/dashboard/summary`. Phase 6b changes the *bootstrap* chain; it must not fan the dashboard's own fetch into multiple calls.
- [ ] Scan Receipt still requires explicit user confirmation before saving OCR'd values (`RecordsScreens.tsx:1189-1639`). No phase should have made saving automatic.
- [ ] No new steps added to record-an-expense. Count taps from Records screen to saved expense before and after; it must not increase.

**#6 Honest (3/3)**
- [ ] `grep -rniE "powerful|smart|instantly|seamless|effortless|magic|revolutionary" src/` — empty.
- [ ] AI disclaimers intact and unchanged in tone: `RecordsScreens.tsx:1242-1246`, `AskFinSight.tsx:298-301`.
- [ ] Every new label added in Phase 3 maps 1:1 to actual behavior — no aspirational copy.
- [ ] No new confirmshaming: destructive dialogs still use neutral pairs ("Keep it" / "Delete").

**#7 Long-lasting (3/3)**
- [ ] Still exactly **one** shadow declaration app-wide (`styles.card`, `ui.tsx:560-571`) — `ExecutiveSummaryCard`'s was removed in Phase 1 and nothing added one back. `grep -rn "shadowColor\|elevation" src/` should return one style block.
- [ ] New chip primitives are flat: no gradients, no glass blur, no skeuomorphic shadows.
- [ ] Palette unchanged — `git diff src/theme/tokens.ts` shows no value changes (comments/docs may change).

### Full-suite verification
```bash
cd mobile && npm run typecheck && npm test
cd ../backend && npm test          # confirm no accidental cross-app breakage
cd ../web && npm run typecheck     # web is a separate app and must be untouched
git diff --stat -- web/            # must be empty
```

### Static-scan tests added by this plan
- `tests/chipConsistency.test.ts` (Phase 2) — no hand-rolled selected-chip styling outside `ui.tsx`
- `tests/successFeedback.test.ts` (Phase 3) — every `haptics.succeeded()` has a visual sibling
- `tests/useReducedMotion.test.ts` (Phase 6) — hook behavior + cleanup

### Consolidated live-device QA list
Static analysis cannot cover these. Run on both iOS and Android before shipping:
1. Chip wrapping at narrow widths with long Filipino category names (Phase 2)
2. Success `Callout` timing and dismissal (Phase 3)
3. Keyboard avoidance + focus-scroll across all nine forms — **highest risk item in the plan** (Phase 4)
4. VoiceOver / TalkBack traversal, including section-header jumping (Phase 5)
5. Reduce Motion system toggle affecting both animation sites (Phase 6)
6. Cold-start timing before/after; full auth cycle if 6b shipped (Phase 6)

### Re-score
Re-run the Rams audit against the refined app. Expected movement: #4 understandable 1→2/3 (Phases 2, 3), #8 thorough 1→3/3 (Phases 3, 4), #10 as-little-as-possible 1→3/3 (Phases 1, 2), #9 environmentally friendly 2→3/3 (Phase 6). Projected total **20/30 → 26-27/30** without touching information architecture or navigation.

---

## Deliberately out of scope

Named so they are not rediscovered as oversights:
- Information architecture and navigation structure (bottom tabs, stack layout)
- Token **values** — palette, type scale, spacing scale. Only usage discipline is in scope.
- New screens or features
- A component-testing framework
- `react-native-reanimated` and the `ReanimatedSwipeable` migration (large native dep; logged as tech debt)
- Relocating `Field` from `AuthScreens.tsx` to `ui.tsx` (mechanical follow-up, noted in Phase 4)
- `GapOption` and AskFinSight starter chips (documented decisions, Phase 2)
- The separate `web/` app — must remain untouched
