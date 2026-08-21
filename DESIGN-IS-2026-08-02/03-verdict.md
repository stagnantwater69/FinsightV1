# Verdict — FinSight Mobile

**REFINE.** FinSight's mobile app scores 20/30 with no principle at 0: the bones are genuinely good — honest, restrained AI-adjacent copy (3/3), a durable non-trend-chasing visual language (3/3), and a primary task that completes in a single dashboard call with no decoy actions (3/3) — and the gaps that remain are specific, fixable, and don't require touching the information architecture or navigation structure at all.

## Top 5 highest-leverage moves

1. **[#10 as little as possible / #4 understandable] Consolidate the segmented-control/pill sprawl.** Seven independent re-implementations of the same "select one of N options" affordance exist with no shared component — `InsightsScreens.tsx:14-44` (InsightTabs), `:89-107` (period toggle), `DashboardScreen.tsx:88-109` (PERIODS), `RecordsScreens.tsx:168-195` (FilterChip), `:537-572` (CategoryChips), `:614-699` (CategoryPicker inline chips), `:1740-1763` (CSV header chips), `DateField.tsx:165-217` (DateRangeChips). One shared primitive would fix both the duplication (#10) and the recognition-over-recall break where the same concept looks different on every screen (#4).

2. **[#8 thorough] Add focus and success states app-wide.** Zero `onFocus` handling exists anywhere — every text field keeps a static border regardless of keyboard focus. Success feedback is missing on Dashboard, the Records list, all three Insights tabs, and Notifications (present only in Auth, Scan Receipt, and CSV Import). Both states are systemically absent, not just rough in one place.

3. **[#4 understandable] Plain-language the flagship value-prop terms.** "Recovery target," "Adjusted daily target" (`RecoveryMeter.tsx:69`), "Sales reference" (`DashboardScreen.tsx:149`), and "Large-expense threshold (%)" (`BusinessScreens.tsx:274`) sit at the center of what makes FinSight distinctive, but a first-time small-business owner won't parse them without help.

4. **[#10 as little as possible] Delete or wire up 5 confirmed-dead components and 3 unused props.** `ExecutiveSummaryCard`, `Pill`, `Divider` (`ui.tsx:307-344,255-303,531-533`), `SeriesDot`, `HeroFigure` (`charts.tsx:421-432,389-418`) have zero call-sites. `Alert.action`, `Money.bare`/`Money.decimals`, `RecoveryMeter.compact` are defined and rendered but never passed by any caller.

5. **[#9 environmentally friendly] Parallelize the bootstrap chain and respect reduced-motion.** `auth/me` → `/business-profiles` → `/records/categories` run sequentially via effect-chaining (`AuthContext.tsx:51-58`, `BusinessProfileContext.tsx:37-46,64,67-69`) rather than `Promise.all`'d, adding avoidable latency before the font-loading spinner (`App.tsx:296-322`) even resolves. Separately, `AccessibilityInfo.isReduceMotionEnabled` has zero matches anywhere — the loading shimmer (`Skeleton.tsx:16-35`) and AskFinSight sheet animation (`AskFinSight.tsx:98-113,153`) should gate on it.

**One-line quick win worth bundling in:** `RecoveryMeter.tsx:81` hardcodes `#e8efed`, an exact duplicate of `paper[200]` — swap it for the token import while touching that file for move #2.
