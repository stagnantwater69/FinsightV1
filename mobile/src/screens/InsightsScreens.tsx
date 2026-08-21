/**
 * Barrel for the three insight screens.
 *
 * They used to live in one 1971-line file. Each is now its own module
 * (ExpenseBehaviorScreen.tsx, SpendingImpactScreen.tsx,
 * RecoveryTargetScreen.tsx), with the pieces they share — InsightHeader,
 * Medallion, DeltaPill, SubTabs, ScheduleRow, STATUS_SURFACE — pulled into
 * components/InsightsShared.tsx and the shared data-fetch hook into
 * lib/useInsight.ts. This file stays so `./src/screens/InsightsScreens`
 * remains a valid import path for App.tsx without every caller having to
 * learn the new layout.
 */
export { ExpenseBehaviorScreen } from "./ExpenseBehaviorScreen";
export { SpendingImpactScreen } from "./SpendingImpactScreen";
export { RecoveryTargetScreen } from "./RecoveryTargetScreen";
