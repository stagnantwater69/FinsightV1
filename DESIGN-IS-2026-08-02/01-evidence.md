# Evidence — FinSight Mobile (`mobile/src/`)

15 files, ~6,300 lines read in full across 5 parallel subagents (Structural, Visual, Copy & Honesty, Weight & Friction, Accessibility). No live simulator was available, so Visual/Weight facts are source-derived (INFERRED) rather than rendered/measured — noted inline.

## Structural
- ~125 static interactive-element call-sites across 7 screen files (RecordsScreens.tsx alone: 68 incl. 6 local sub-components).
- Max nesting depth ~8-9 levels in `RecordsScreens.tsx` `ScanReceiptScreen` (:1189-1639), ~6 in `InsightsScreens.tsx` `ExpenseBehaviorScreen`.
- DRY core: `Card` (ui.tsx:146, 33 usages), `Button` (ui.tsx:89, 47 usages), `EmptyState` (ui.tsx:349, 8 usages), `AskFinSight` modal (4 call-sites) — all reused cleanly.
- Duplicated: **7+ independent segmented-control/pill re-implementations** with no shared component — `InsightsScreens.tsx:14-44` (InsightTabs), `:89-107` (period toggle), `DashboardScreen.tsx:88-109` (PERIODS), `RecordsScreens.tsx:168-195` (FilterChip), `:537-572` (CategoryChips), `:614-699` (CategoryPicker inline chips), `:1740-1763` (CSV header chips), `DateField.tsx:165-217` (DateRangeChips).
- 3 different "add new X" UI patterns: top button row (`RecordsScreens.tsx:344-349`), inline create-in-picker (`CategoryPicker:614-699`), "+" text-link (`:1449-1462`), EmptyState CTA (`BusinessScreens.tsx:125`).
- 3 hand-written destructive-confirm `Alert.alert` blocks, same shape, no shared helper: `BusinessScreens.tsx:36-58`, `RecordsScreens.tsx:272-299`, `:1880-1904`.
- 5 fully unused exported components: `ExecutiveSummaryCard` (ui.tsx:307-344), `Pill` (ui.tsx:255-303), `Divider` (ui.tsx:531-533), `SeriesDot` (charts.tsx:421-432), `HeroFigure` (charts.tsx:389-418).
- Unused props: `Alert.action` (ui.tsx:211,235 — never passed, only `EmptyState.action` used), `Money.bare`/`Money.decimals` (ui.tsx:59-60), `RecoveryMeter.compact` (RecoveryMeter.tsx:18 — both callers omit it).
- No unused imports found.

## Visual / Tokens (INFERRED — source read, no render)
- Spacing: 296 uses of `space.*` tokens vs. ~74 hardcoded literals — nearly all bypasses are sub-8px micro-nudges (icon/glyph adjustments), not layout-level.
- Type: named 5-step scale (title 20/heading 15/body 15/label 13/caption 12) but 11 distinct literal `fontSize` values app-wide; 72% cluster at 12-15px (disciplined middle), extremes (18/20/22/26/30) are one-off title/hero/wordmark overrides.
- Color: 13 distinct hex values outside the token objects. Most are a consistent (if undocumented) alert-tint family (danger/warning/success surface tints used consistently for the same semantic purpose). One confirmed **drift bug**: `RecoveryMeter.tsx:81` hardcodes `#e8efed`, an exact duplicate of `paper[200]` (tokens.ts:77), instead of importing the token.
- Contrast violation at scale: `ink[400]` (3.36:1, documented in tokens.ts:65 as "decorative/placeholder only") is the default color of the `caption` **variant** (ui.tsx:34), used **95 times** for functional text — dates, hints, chart axis labels — not decoration. This is a real AA-body-text failure, not just a placeholder.
- States checklist: empty/loading/error present on nearly every major flow. **Focus state: absent everywhere** (no `onFocus` handling found; every TextInput keeps a static border regardless of keyboard focus). **Success state: missing** on Dashboard, Records list, Insights (3 tabs), Notifications; present in Auth (recover-password confirmation), ScanReceipt (balance badge), Import CSV (result summary).

## Copy & Honesty
- Zero inflations found (no "powerful/smart/effortless/seamless/magic"); copy is deliberately deflationary — e.g. "Composed from your records — not AI-written" (ui.tsx:309,334), "these values were interpreted from the photo by AI" with explicit review prompts (RecordsScreens.tsx:1242-1246).
- Zero dark patterns found: no confirmshaming, no pre-checked opt-ins, no fake scarcity, no forced continuity.
- Zero label→behavior mismatches found (delete/resolve/close/save controls all do what they say).
- 4 flagged jargon/unclear labels, all core to the flagship value proposition: "Sales reference" (DashboardScreen.tsx:149), "Recovery target"/"Adjusted daily target" (RecoveryMeter.tsx:69, DashboardScreen.tsx:214), "Large-expense threshold (%)" (BusinessScreens.tsx:274).

## Weight & Friction (ESTIMATED — no build/runtime available)
- Charts are hand-built on `react-native-svg` primitives by explicit design choice (charts.tsx:8-13 comment: avoids a "far larger" charting-library bundle) — structurally light.
- Dashboard's own data need is a single consolidated call (`DashboardScreen.tsx:38-41`, `/dashboard/summary`).
- But the **bootstrap chain before the dashboard can render is sequential, not parallel**: `AuthContext.tsx:51-58` (session→`/auth/me`) → `BusinessProfileContext.tsx:37-46` (`/business-profiles`) → `:64,67-69` (`/records/categories`, effect-chained) → then the dashboard's own call. No `Promise.all` anywhere in this chain.
- `App.tsx:296-322` blocks all rendering behind `Font.loadAsync` for 8 individual font weights, with only a bare `ActivityIndicator` shown — no `expo-splash-screen` hold API used to soften this.
- One idle-looping animation: `Skeleton.tsx:16-35` shimmer, but it self-stops once data arrives (loading-window only, not indefinite).
- `AccessibilityInfo.isReduceMotionEnabled` / any reduced-motion handling: **zero matches repo-wide**.
- No auto-opening modal/alert/badge on load found anywhere (`Alert.alert` on mount: none; `tabBarBadge`: none configured).

## Accessibility
- Contrast: ink500-900 and all statusText tokens pass WCAG AA (4.5:1+) against white/paper. ink400 fails (3.36:1) and is the `caption` variant default — see Visual section above, live risk not just a documented carve-out.
- No `returnKeyType`/`onSubmitEditing` chaining in ANY multi-field form (Auth, BusinessProfile, Add/Edit Expense/Sales, Scan Receipt) — keyboard "next" order is entirely unimplemented; only visual/DOM order exists.
- All primary actions use `Pressable` (31 instances) — baseline reachable — but `accessibilityRole="button"` is inconsistently applied: missing at `DashboardScreen.tsx:155-166`, `InsightsScreens.tsx:90-107,288-300`, `RecordsScreens.tsx:1745-1759`. 26 of ~91 `onPress` sites have explicit `accessibilityRole` (many others inherit it from shared primitives).
- Swipe-to-delete/resolve (`RecordsScreens.tsx:140-164`) has no non-gesture fallback control for users who can't perform the swipe gesture via assistive tech.
- No `accessibilityRole="header"` anywhere (0 hits) despite many section titles that would let screen-reader users jump between sections — no landmark/skip equivalent exists.
- Only one `<Image>` element in the whole app (`PhotoUpload.tsx:87`) and it has no `accessibilityLabel`.
