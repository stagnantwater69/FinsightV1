# Scope Lock

**Audited surface:** `mobile/` — FinSight's Expo/React Native mobile app (NOT the `web/` React app, which is a separate codebase with its own pages).

- Screens: `mobile/src/screens/AuthScreens.tsx`, `BusinessScreens.tsx`, `DashboardScreen.tsx`, `InsightsScreens.tsx`, `MoreScreen.tsx`, `NotificationsScreen.tsx`, `RecordsScreens.tsx` (2022 lines — largest file, likely holds records list/detail/add/edit/import flows)
- Shared components: `AskFinSight.tsx`, `AtAGlance.tsx`, `charts.tsx`, `DateField.tsx`, `PhotoUpload.tsx`, `RecordOrigin.tsx`, `RecoveryMeter.tsx`, `Skeleton.tsx`, `ui.tsx` (611 lines — likely the primitive kit: Button, Card, Input, etc.)
- Design tokens: `mobile/src/theme/tokens.ts` (135 lines) — explicitly documented as a hand-kept mirror of `web/tailwind.config.js` / `web/src/lib/chartPalette.ts`

**Primary user:** A small-business owner or sole proprietor in the Philippines (evidenced by Filipino-language synonyms found in the web CSV importer — "petsa", "halaga", "tindahan") tracking expenses, sales, and receipts on their phone, likely between customers or after closing up shop.

**Primary task:** Record a transaction (expense or sale, often from a receipt photo) and understand at a glance whether the business is financially healthy — the "Recovery Meter" and "At a Glance" component names suggest a recovery/health-tracking framing specifically, not generic bookkeeping.

**Constraints:**
- Brand: teal (`brand` 50–950, `#149e8d` at 500) as primary, amber (`accent`, `#f5a524` at 400) reserved for exactly two uses per an explicit code comment — Recovery Meter's adjusted daily target, and primary CTAs. This constraint is already documented in-code, not a green-field choice.
- Stack: Expo 57 / React Native 0.86 / React Navigation 7 (bottom tabs + native stack). No design library (no NativeBase/Tamagui/RN Paper) — `ui.tsx` is a from-scratch primitive kit.
- Contrast already measured and documented in tokens.ts (e.g., `ink[400]` flagged "decorative / placeholder only — 3.36:1, not for body text"; amber-on-white CTA rule justified by a measured 8.08:1 dark-ink-on-accent-400 ratio).
- Fonts: Inter (UI), IBM Plex Sans (display/headings), IBM Plex Mono (numeric/financial figures) — via `@expo-google-fonts`, mirrored from web's `@fontsource` set.
- No running simulator/device available in this environment — visual evidence will be gathered by reading source (JSX + StyleSheet/token usage), not live screenshots. Facts derived this way are marked INFERRED in `01-evidence.md`, per the design-is skill's static-target protocol.

**Reference designs invoked by the requester:** Kwentapro, QuickBooks, Zoho, Notion, Stripe, Linear, Revolut, Apple's own apps — cited as quality bar, not as flows to imitate.

**Note on brief vs. skill:** The user's brief asks for a full modern-mobile-heuristics review (HIG, Material 3, WCAG, 8pt grid, a dozen named UX laws) layered on top of a Rams audit, plus a from-scratch design system proposal. This audit runs the Rams scorecard first (per the design-is skill) to produce an evidence-backed verdict and priority list; the additional per-screen commentary and full design-system deliverable are produced in Phase 4's handoff plan, not invented ad hoc here, so that the priority order is grounded in the scored evidence rather than a parallel unscored checklist.
