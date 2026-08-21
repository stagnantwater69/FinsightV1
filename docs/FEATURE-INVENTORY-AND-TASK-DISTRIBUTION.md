# FinSight — Feature Inventory & Team Task Distribution

**Date:** 15 August 2026
**Purpose:** Complete inventory of implemented features across the Web and Mobile applications, verified against the actual source code (not documentation claims), paired with a realistic task-distribution plan for the team.

**Attribution note:** Ken designed and implemented essentially all of the current system — backend architecture, database, authentication/security, AI integration, OCR/receipt pipeline, financial analytics, anomaly detection, and the full Web and Mobile applications. This document does **not** claim otherwise. The "Assigned To" column below identifies realistic, verifiable **refinement, testing, documentation, and small-improvement tasks** that Jah, Jimz, and Kurt can take ownership of on top of Ken's existing implementation — not original authorship of the underlying feature.

---

## How to read this document

Each feature lists:
- **Feature Name**
- **Platform:** Web or Mobile
- **Short Description**
- **Status:** Fully Implemented / Partially Implemented
- **Main files/components**
- **Difficulty:** Easy / Moderate / Difficult (mapped from code complexity, integration depth, and system criticality)
- **Possible teammate task:** a small, low-risk, well-scoped task connected to this feature that Jah, Jimz, or Kurt could realistically own

Difficulty mapping used throughout: code that is a simple form/CRUD/static content → **Easy**; code with real state management, multi-step flows, or moderate integration → **Moderate**; multi-service pipelines, AI/OCR, anomaly detection, security-sensitive flows, or complex async/animation engineering → **Difficult**.

---

## Part 1 — Web Application Features

### 1. Authentication & Account Lifecycle

| Feature | Description | Status | Main Files | Difficulty | Possible Teammate Task |
|---|---|---|---|---|---|
| Login | Email/password login, "remember me", session-expired banner | Fully Implemented | `web/src/pages/Login.tsx`, `context/AuthContext.tsx` | Easy | Improve inline error message wording; add "show password" toggle polish |
| Register | Multi-field signup with pending-account email confirmation | Fully Implemented | `web/src/pages/Register.tsx`, `lib/authValidation.ts` | Moderate | Improve field-validation error copy; test edge cases (long names, special characters) |
| Email confirmation | Consumes confirmation link, activates account, resend option | Fully Implemented | `web/src/pages/ConfirmEmail.tsx` | Moderate | Test expired/invalid link states; improve "resend" button loading state |
| Forgot / Recover password | Requests reset email (anti-enumeration safe) | Fully Implemented | `web/src/pages/RecoverPassword.tsx` | Easy | UI copy polish; add success-state illustration |
| Reset password | Sets new password from recovery link, revokes other sessions | Fully Implemented | `web/src/pages/ResetPassword.tsx` | Difficult | (Security-sensitive — keep with Ken) |
| Logout / Logout everywhere | Single-device vs. all-device sign-out | Fully Implemented | `context/AuthContext.tsx`, `pages/Profile.tsx` | Easy | Add confirmation dialog copy review |
| Change password | In-app password change with current-password check | Fully Implemented | `pages/Profile.tsx` (SecurityPanel) | Easy | Add password-strength indicator UI |
| Delete account | Password-gated permanent account deletion | Fully Implemented | `pages/Profile.tsx` (DeleteAccountPanel) | Moderate | Improve confirmation dialog wording/warning clarity |
| Profile management | Edit name/phone, avatar upload | Fully Implemented | `pages/Profile.tsx`, `components/Avatar.tsx` | Easy | Add avatar upload progress indicator; file-size error messaging |

### 2. Onboarding & Business Profile

| Feature | Description | Status | Main Files | Difficulty | Possible Teammate Task |
|---|---|---|---|---|---|
| Guided onboarding wizard | 3-step setup wizard with localStorage draft persistence | Fully Implemented | `pages/Onboarding.tsx`, `lib/onboardingDraft.ts` | Difficult | Improve step-transition copy/microcopy; test skip/resume flow |
| Business profile view | Shows active business's funds/expenses/thresholds | Fully Implemented | `pages/BusinessProfiles.tsx` | Easy | Add empty-field placeholder text |
| All business profiles (list/switch/archive) | Card grid, search, switch, archive/restore | Fully Implemented | `pages/AllBusinessProfiles.tsx`, `components/BusinessSwitcher.tsx` | Moderate | Test archive/restore flow; improve empty-search-results state |
| Create business profile | Simple form | Fully Implemented | `pages/CreateBusinessProfile.tsx` | Easy | Add field-level helper text/tooltips |
| Edit business profile (+ logo upload) | Simple form with image upload | Fully Implemented | `pages/EditBusinessProfile.tsx` | Easy | Add logo upload preview/crop polish |

### 3. Records — CRUD, Filtering, Search

| Feature | Description | Status | Main Files | Difficulty | Possible Teammate Task |
|---|---|---|---|---|---|
| Records list (unified table) | Paginated, searchable, filterable, sortable table | Fully Implemented | `pages/Records.tsx`, `components/DataTable.tsx` | Difficult | Add column-sort visual indicator polish; test mobile card layout |
| Add expense (page + modal) | Form with category select, celebration state | Fully Implemented | `pages/AddExpense.tsx`, `components/AddExpenseModal.tsx` | Easy | Improve first-expense celebration animation/copy |
| Edit expense | Simple CRUD form | Fully Implemented | `pages/EditExpense.tsx` | Easy | Add "unsaved changes" warning on navigate-away |
| Add sales record (page + modal) | Simple CRUD form | Fully Implemented | `pages/AddSalesRecord.tsx`, `components/AddSalesModal.tsx` | Easy | Add input formatting polish (currency masking) |
| Edit sales record | Simple CRUD form | Fully Implemented | `pages/EditSalesRecord.tsx` | Easy | Test validation edge cases |
| Expense category management | Create/list/search categories | Fully Implemented | `pages/Categories.tsx` | Easy | Add empty-state illustration; test search UX |

### 4. Receipt Scanning / OCR

| Feature | Description | Status | Main Files | Difficulty | Possible Teammate Task |
|---|---|---|---|---|---|
| Scan receipt (multi-photo OCR + AI vision + itemization) | Multi-service AI/OCR pipeline with review/reconciliation UI | Fully Implemented | `pages/ScanReceipt.tsx`, `lib/receiptReview.ts` | Difficult | (Core AI/OCR logic — keep with Ken. Teammates can test UX with real receipts and log issues) |
| Receipt capture quality check & edge detection | Pre-upload readability check, edge detection for cropping | Fully Implemented | backend `imageQuality.ts`, `edgeDetection.ts` | Difficult | (Keep with Ken — core algorithm) |

### 5. CSV Import

| Feature | Description | Status | Main Files | Difficulty | Possible Teammate Task |
|---|---|---|---|---|---|
| CSV import with smart column mapping | Auto column mapping, mixed-file detection, validation preview | Fully Implemented | `pages/ImportCsv.tsx`, `lib/recordTypeDetection.ts` | Difficult | Test with varied real-world CSV files (bank exports, POS exports) and document edge cases found |

### 6. Duplicate & Anomaly Detection UI

| Feature | Description | Status | Main Files | Difficulty | Possible Teammate Task |
|---|---|---|---|---|---|
| Flagged records review queue | Groups duplicate flags, plain-language explanations, bulk resolve | Fully Implemented | `pages/FlaggedRecords.tsx` | Moderate | Review/improve the plain-language explanation copy for clarity |
| Duplicate review modal | Side-by-side comparison of flagged vs. original record | Fully Implemented | `components/DuplicateReviewModal.tsx` | Moderate | UI polish; test comparison layout on smaller screens |
| Anomaly / findings review (outliers, recurring patterns) | Review queue UI backed by multi-algorithm detection pipeline | Fully Implemented | `pages/ExpenseInsight.tsx` | Difficult | (Backend detection logic — keep with Ken. Teammates can test review UI and log confusing cases) |

### 7. Dashboard & Insights (Analytics/Charts)

| Feature | Description | Status | Main Files | Difficulty | Possible Teammate Task |
|---|---|---|---|---|---|
| Main Dashboard | KPIs, charts, recovery meter, empty states, period toggle | Fully Implemented | `pages/Dashboard.tsx`, `components/DonutChart.tsx` | Difficult | Test empty-state behavior across account-age scenarios; polish chart legend/labels |
| Expense Insight | Category analytics, findings review, recurring patterns | Fully Implemented | `pages/ExpenseInsight.tsx` | Difficult | (Core analytics — keep with Ken. Teammates can test period-picker edge cases) |
| Recovery Target Insight | Month-to-date sales tracking vs. target | Fully Implemented | `pages/RecoveryInsightPage.tsx` | Moderate | Improve daily-coverage table sorting/formatting |
| Spending Impact (what-if simulator) | Live-debounced impact calculator with AI category suggestion | Fully Implemented | `pages/SpendingImpact.tsx` | Moderate | Polish before/after bar visualization; test debounce responsiveness |

### 8. AI Chat / "Ask FinSight"

| Feature | Description | Status | Main Files | Difficulty | Possible Teammate Task |
|---|---|---|---|---|---|
| Ask FinSight drawer | Contextual AI chat, per-module scoping, conversation history | Fully Implemented | `components/AskFinSightDrawer.tsx` | Difficult | (AI integration — keep with Ken. Teammates can write/refine starter-prompt copy per module) |
| AI category suggestion | Suggests category from free-text description | Fully Implemented | used in `ScanReceipt.tsx`, `SpendingImpact.tsx` | Difficult | (Keep with Ken) |

### 9. Notifications

| Feature | Description | Status | Main Files | Difficulty | Possible Teammate Task |
|---|---|---|---|---|---|
| Notification bell + dropdown | Header bell, unread count, recent list | Fully Implemented | `components/NotificationBell.tsx` | Easy | Polish dropdown animation/empty state |
| Full notification archive | All/Unread tabs, grouped by day, deep links | Fully Implemented | `pages/Notifications.tsx` | Moderate | Test deep-link behavior for each notification type |

### 10. Global Navigation & Search

| Feature | Description | Status | Main Files | Difficulty | Possible Teammate Task |
|---|---|---|---|---|---|
| App shell (responsive nav) | Sidebar/topbar, business switcher, search, theme switcher | Fully Implemented | `components/AppShell.tsx` | Moderate | Test responsive breakpoints on tablet-sized screens |
| Global search (command palette) | Hybrid local/remote search with combobox nav | Fully Implemented | `components/GlobalSearch.tsx` | Moderate | Test keyboard navigation edge cases; improve "no results" state |
| Theme switcher | Classic/Light/Dark, persisted | Fully Implemented | `context/ThemeContext.tsx` | Easy | Verify color contrast on all three themes across every page |

### 11. Marketing / Public Pages

| Feature | Description | Status | Main Files | Difficulty | Possible Teammate Task |
|---|---|---|---|---|---|
| Landing page | Hero, feature grid, process timeline, FAQ accordion | Fully Implemented | `pages/Landing.tsx` | Moderate | Content/copy review; test responsive layout on mobile browsers |
| FAQs, Blogs, Tutorials, Contact, Privacy, Terms | Static/content pages | Fully Implemented | `pages/Faqs.tsx`, `Blogs.tsx`, `Tutorials.tsx`, `Contact.tsx`, `Privacy.tsx`, `Terms.tsx` | Easy | Write/expand FAQ content; proofread legal page text; add new tutorial entries |

### 12. Shared UI Infrastructure

| Feature | Description | Status | Main Files | Difficulty | Possible Teammate Task |
|---|---|---|---|---|---|
| Toast notifications | Toasts with undo action | Fully Implemented | `components/Toast.tsx` | Easy | Test undo timing/edge cases |
| Confirmation dialogs | Replaces native `confirm()` | Fully Implemented | `components/ConfirmDialog.tsx` | Easy | Copy review across all usages for consistency |
| Empty states | Empty-state + setup-progress checklist variant | Fully Implemented | `components/EmptyState.tsx` | Easy | Design/write empty-state copy and icons for any missing screens |
| Skeleton loaders | Shape-matched loading placeholders | Fully Implemented | `components/Skeleton.tsx` | Easy | Verify skeletons match final layout on all pages that use them |
| Error boundary | Top-level crash guard | Fully Implemented | `components/ErrorBoundary.tsx` | Easy | Improve fallback error screen copy/design |
| DataTable (sortable/paginated) | Shared table with responsive card view | Fully Implemented | `components/DataTable.tsx` | Difficult | (Core shared component — test thoroughly rather than modify) |
| Form field kit | Validated inputs, money input, file input | Fully Implemented | `components/Field.tsx` | Easy | Add/improve inline validation error messages |

---

## Part 2 — Mobile Application Features

### 1. Authentication & Account Access

| Feature | Description | Status | Main Files | Difficulty | Possible Teammate Task |
|---|---|---|---|---|---|
| Login | Email/password, "remember me", field validation | Fully Implemented | `screens/AuthScreens.tsx` | Easy | Test on multiple device sizes; polish error message copy |
| Registration (pending confirmation) | Signup → pending state → email confirm, resend option | Fully Implemented | `AuthScreens.tsx` (RegisterScreen) | Moderate | Test resend-verification flow; polish "check your email" screen copy |
| Forgot / Recover password | Requests reset email | Fully Implemented | `AuthScreens.tsx` (RecoverPasswordScreen) | Easy | UI polish |
| Reset password (deep-link) | Handles deep link, sets new password, revokes sessions | Fully Implemented | `AuthScreens.tsx`, `lib/authLinkTokens.ts` | Difficult | (Security-sensitive — keep with Ken) |
| Email confirmation (deep-link) | Handles confirmation deep link | Fully Implemented | `AuthScreens.tsx` (ConfirmEmailScreen) | Moderate | Test deep-link behavior on physical Android devices |
| Logout / Logout everywhere | Local vs. global sign-out | Fully Implemented | `context/AuthContext.tsx`, `MoreScreen.tsx` | Easy | Test confirmation dialogs |
| Change password | In-app password change | Fully Implemented | `BusinessScreens.tsx` (ProfileScreen) | Easy | Add password-strength indicator |
| Account deletion | Password-gated permanent deletion | Fully Implemented | `BusinessScreens.tsx` | Moderate | Improve confirmation copy/warning clarity |

### 2. Onboarding & Business Profile

| Feature | Description | Status | Main Files | Difficulty | Possible Teammate Task |
|---|---|---|---|---|---|
| 3-step onboarding wizard | Business setup wizard, SecureStore draft persistence | Fully Implemented | `screens/OnboardingScreens.tsx` | Difficult | Test skip/resume flow across app restarts; polish step copy |
| Business profile CRUD | Create/edit/list/switch, logo upload | Fully Implemented | `screens/BusinessScreens.tsx` | Moderate | Test logo upload on both iOS/Android; polish form layout |
| Archive / restore business profile | Soft-delete with restore | Fully Implemented | `BusinessScreens.tsx` | Moderate | Test archive/restore edge cases |

### 3. Dashboard (Home)

| Feature | Description | Status | Main Files | Difficulty | Possible Teammate Task |
|---|---|---|---|---|---|
| Dashboard summary | Funds/sales/expenses tiles, setup checklist, empty states | Fully Implemented | `screens/DashboardScreen.tsx` | Difficult | Test empty-state fallback logic across account ages |
| Cashflow chart | Daily/monthly toggle chart | Fully Implemented | `components/charts.tsx` | Moderate | Polish chart axis labels/legend |
| Spending breakdown flip card | Donut ⇄ ranked list animated flip | Fully Implemented | `components/SpendingBreakdownCard.tsx` | Moderate | Test flip animation on lower-end devices; verify reduced-motion behavior |
| Greeting hero + mascot animation | Personalized greeting, animated mascot, composed insight line | Fully Implemented | `components/GreetingHero.tsx` | Difficult | Write/expand the composed insight-line message variants (copywriting task) |
| Home header | Business switcher, avatar, notification bell | Fully Implemented | `components/HomeHeader.tsx` | Easy | Polish switcher dropdown UI |
| Quick actions grid | Shortcut grid to key actions | Fully Implemented | `components/QuickActions.tsx` | Easy | Add/rearrange shortcuts; icon polish |
| Pull-to-refresh | Standard refresh control | Fully Implemented | Dashboard/Records/Notifications screens | Easy | Test refresh behavior across screens |

### 4. Records (Sales & Expenses)

| Feature | Description | Status | Main Files | Difficulty | Possible Teammate Task |
|---|---|---|---|---|---|
| Records list (search/filter/sort) | Paginated list with 7+ filter dimensions, swipe gestures | Fully Implemented | `screens/RecordsScreens.tsx` | Difficult | Test swipe-to-delete/resolve gestures across devices; polish filter chip UI |
| Add expense | Category picker, form | Fully Implemented | `RecordsScreens.tsx` (AddExpenseScreen) | Easy | Test category inline-create flow |
| Add sales reference | Simple form | Fully Implemented | `RecordsScreens.tsx` (AddSalesScreen) | Easy | Test input validation edge cases |
| Edit / delete record | Edit any field, delete, mark reviewed | Fully Implemented | `RecordsScreens.tsx` (EditRecordScreen) | Moderate | Test edit flow for receipt-sourced vs. manual records |
| Category management | List/search/create categories | Fully Implemented | `screens/CategoriesScreen.tsx` | Easy | Polish empty-state and search UX |
| Duplicate/anomaly review queue | Grouped flagged records, bulk keep/discard | Fully Implemented | `RecordsScreens.tsx` (FlaggedRecordsScreen) | Difficult | Test bulk-resolve flow; verify counts match server response |

### 5. Receipt Scanning / OCR (Camera Pipeline)

| Feature | Description | Status | Main Files | Difficulty | Possible Teammate Task |
|---|---|---|---|---|---|
| Custom in-app receipt camera | Framing guide, multi-page session, torch, gallery fallback | Fully Implemented | `components/receipt-camera/ReceiptCamera.tsx` | Difficult | (Core camera engineering — keep with Ken. Teammates can test on physical devices and log usability issues) |
| Crop editor | Draggable 4-corner crop UI | Fully Implemented | `components/receipt-camera/CropEditor.tsx` | Difficult | (Keep with Ken) |
| Capture preview / section strip | Review capture, reorder/remove sections | Fully Implemented | `components/receipt-camera/CapturePreview.tsx` | Moderate | Test multi-page reordering UX |
| Multi-page receipt scan + polling | Upload, poll processing status, retry on failure | Fully Implemented | `screens/RecordsScreens.tsx` (ScanReceiptScreen) | Difficult | (Keep with Ken — core pipeline) |
| Itemized receipt review & reconciliation | Per-item categorization, gap reconciliation | Fully Implemented | `RecordsScreens.tsx` | Difficult | (Core financial logic — keep with Ken. Teammates can test with real receipts and document confusing UI moments) |

### 6. CSV Import

| Feature | Description | Status | Main Files | Difficulty | Possible Teammate Task |
|---|---|---|---|---|---|
| CSV import wizard | Column mapping, mixed-file detection, results summary | Fully Implemented | `screens/RecordsScreens.tsx` (ImportCsvScreen) | Difficult | Test with varied CSV files on mobile; document any parsing issues found |
| CSV import entry from onboarding | Cross-tab handoff into importer | Fully Implemented | `App.tsx` | Moderate | Test navigation handoff edge cases |

### 7. AI Features

| Feature | Description | Status | Main Files | Difficulty | Possible Teammate Task |
|---|---|---|---|---|---|
| Ask FinSight (AI chat) | Draggable bottom sheet, per-module scoping | Fully Implemented | `components/AskFinSight.tsx` | Difficult | (Keep with Ken. Teammates can write/refine starter-question copy per module) |
| AI-suggested categorization | Suggests categories during receipt review | Fully Implemented | `lib/categorySuggestion.ts` | Difficult | (Keep with Ken) |

### 8. Insights & Analytics

| Feature | Description | Status | Main Files | Difficulty | Possible Teammate Task |
|---|---|---|---|---|---|
| Expense Insight (Behavior) | Overview/Alerts/Recurring sub-tabs, anomaly review | Fully Implemented | `screens/InsightsScreens.tsx` | Difficult | Test period-picker edge cases and empty-window logic |
| Spending Impact calculator | Before/after visualization, impact band | Fully Implemented | `InsightsScreens.tsx` (SpendingImpactScreen) | Moderate | Polish before/after bar visualization |
| Recovery Target | Coverage meter, daily target, per-day breakdown | Fully Implemented | `InsightsScreens.tsx`, `components/RecoveryMeter.tsx` | Difficult | Test progress-bar states (behind/on-track/ahead) across scenarios |
| Segmented insight navigation | Header/tab switching between insight screens | Fully Implemented | `InsightsScreens.tsx` (InsightHeader) | Moderate | Polish tab/badge UI |

### 9. Notifications / Alerts

| Feature | Description | Status | Main Files | Difficulty | Possible Teammate Task |
|---|---|---|---|---|---|
| Notifications (alerts) list | Full history, mark-read, pull-to-refresh | Fully Implemented | `screens/NotificationsScreen.tsx` | Easy | Test mark-all-read and optimistic update behavior |
| Unread badge on Home bell | Live unread count | Fully Implemented | `components/HomeHeader.tsx` | Easy | Verify badge updates correctly after actions |

### 10. Navigation & App Shell

| Feature | Description | Status | Main Files | Difficulty | Possible Teammate Task |
|---|---|---|---|---|---|
| Bottom tab nav + Scan quick-action button | 4 tabs + raised radial quick-action menu | Fully Implemented | `App.tsx` (MainTabs), `components/QuickActionMenu.tsx` | Difficult | Test quick-action menu on various screen sizes |
| Stack navigators per tab | Independent native stacks per tab | Fully Implemented | `App.tsx` | Moderate | (Structural — low task potential for teammates) |
| Auth deep-link interception | Handles password-reset/confirm links | Fully Implemented | `App.tsx` (useAuthDeepLink) | Difficult | (Keep with Ken) |
| Splash screen + font loading gate | Parallel font/session loading | Fully Implemented | `App.tsx` | Moderate | Test cold-start timing on lower-end devices |
| Onboarding gate | Routes new users into wizard automatically | Fully Implemented | `App.tsx` (MainOrOnboarding) | Moderate | Test skip/resume gate logic |

### 11. Help & Legal

| Feature | Description | Status | Main Files | Difficulty | Possible Teammate Task |
|---|---|---|---|---|---|
| FAQs | Topic-grouped collapsible Q&A | Fully Implemented | `screens/HelpScreens.tsx` | Easy | Write/expand FAQ content |
| Tutorials | Step cards; video content **not yet built** | Partially Implemented | `HelpScreens.tsx` (TutorialsScreen) | Easy | **Good candidate task:** write tutorial step content, or record/script placeholder walkthrough videos |
| Contact us | Opens device mail client | Fully Implemented | `HelpScreens.tsx` (ContactScreen) | Easy | Proofread support email copy |
| Privacy / Terms | In-app legal documents | Fully Implemented | `HelpScreens.tsx` | Easy | Proofread legal text; keep in sync with web version |

### 12. Profile / Account Settings

| Feature | Description | Status | Main Files | Difficulty | Possible Teammate Task |
|---|---|---|---|---|---|
| Profile editing | Name/phone/avatar | Fully Implemented | `BusinessScreens.tsx` (ProfileScreen) | Easy | Test avatar upload on both platforms |
| "More" hub screen | Central navigation hub | Fully Implemented | `screens/MoreScreen.tsx` | Easy | UI polish/reordering |

### 13. Shared UI System / Cross-Cutting Polish

| Feature | Description | Status | Main Files | Difficulty | Possible Teammate Task |
|---|---|---|---|---|---|
| Design-token/theme system | Fonts, colors, spacing, type scale | Fully Implemented | `theme/tokens.ts` | Moderate | (Keep changes centralized with Ken to avoid breaking consistency lint) |
| Shared primitive component library | Button, Field, Card, EmptyState, etc. | Fully Implemented | `components/ui.tsx` | Difficult | Test individual components for consistency across screens |
| Loading skeletons | Shape-matched placeholders | Fully Implemented | `components/Skeleton.tsx` | Easy | Verify skeletons match final loaded layout |
| Confirmation sheets | Destructive-action dialogs | Fully Implemented | `components/ui.tsx` (ConfirmSheet) | Easy | Copy review for consistency |
| Empty states | Icon/title/body/action pattern | Fully Implemented | `components/ui.tsx` (EmptyState) | Easy | Write/design empty-state copy for any remaining screens |
| Haptics | Wrapped haptic feedback helpers | Fully Implemented | `lib/haptics.ts` | Easy | Test haptic feel across forms/actions on real devices |
| Reduced-motion accessibility support | Gates animations when OS setting is on | Fully Implemented | `lib/useReducedMotion.ts` | Moderate | Test with reduced-motion enabled across all animated components |
| Keyboard-aware forms | "Next" field chaining across all forms | Fully Implemented | applied across screens | Easy | Test keyboard chaining on every form for missed fields |
| Swipeable list rows | Swipe-to-delete/resolve gestures | Fully Implemented | `RecordsScreens.tsx` | Moderate | Test swipe gesture thresholds/sensitivity |

### 14. Explicitly Not Implemented (documented gaps, not tasks to assign lightly)

| Feature | Status | Notes |
|---|---|---|
| Offline support | Not Implemented | Explicitly acknowledged in-app FAQ as a future item; would require an app-wide sync/queue layer |
| On-device OCR / live edge detection | Not Implemented | Deferred due to Expo Go constraints (would need dev-client/bare workflow) |
| Tutorial videos | Partially Implemented | Step text exists; video content does not |

---

## Part 3 — Feature Assignment List (Simple Format)

This is a flat, adviser-friendly list mapping **every feature to one responsible owner going forward** — i.e. who is assigned to maintain/refine/test it from here on. It is **not** a record of who originally wrote the code (see the Attribution Note at the top of this document — git history shows only one author across the whole repository, so no such record exists). Difficult, system-critical features stay with Ken; every Easy/Moderate feature is assigned to Jah, Jimz, or Kurt, grouped by area so each person owns a coherent, explainable slice of the app rather than scattered one-offs.

### Web — Feature Assignment

**Authentication & Account Lifecycle — Jah**
- Web Login – Jah
- Web Register – Jah
- Web Email confirmation – Jah
- Web Forgot/Recover password – Jah
- Web Reset password – **Ken** (security-sensitive)
- Web Logout / Logout everywhere – Jah
- Web Change password – Jah
- Web Delete account – Jah
- Web Profile management – Jah

**Onboarding & Business Profile — Jimz**
- Web Guided onboarding wizard – **Ken** (multi-step state, draft persistence)
- Web Business profile view – Jimz
- Web All business profiles (list/switch/archive) – Jimz
- Web Create business profile – Jimz
- Web Edit business profile – Jimz

**Records — CRUD, Filtering, Search — Kurt**
- Web Records list (unified table) – **Ken** (core shared component)
- Web Add expense – Kurt
- Web Edit expense – Kurt
- Web Add sales record – Kurt
- Web Edit sales record – Kurt
- Web Expense category management – Kurt

**Receipt Scanning / OCR — Ken**
- Web Scan receipt (OCR + AI vision + itemization) – Ken
- Web Receipt capture quality check & edge detection – Ken

**CSV Import — Ken**
- Web CSV import with smart column mapping – Ken

**Duplicate & Anomaly Detection UI — Jah**
- Web Flagged records review queue – Jah
- Web Duplicate review modal – Jah
- Web Anomaly / findings review – **Ken** (multi-algorithm backend)

**Dashboard & Insights — Jimz**
- Web Main Dashboard – **Ken**
- Web Expense Insight – **Ken**
- Web Recovery Target Insight – Jimz
- Web Spending Impact (what-if simulator) – Jimz

**AI Chat / "Ask FinSight" — Ken**
- Web Ask FinSight drawer – Ken
- Web AI category suggestion – Ken

**Notifications — Kurt**
- Web Notification bell + dropdown – Kurt
- Web Full notification archive – Kurt

**Global Navigation & Search — Jah**
- Web App shell (responsive nav) – Jah
- Web Global search (command palette) – Jah
- Web Theme switcher – Jah

**Marketing / Public Pages — Jimz**
- Web Landing page – Jimz
- Web FAQs / Blogs / Tutorials / Contact / Privacy / Terms – Jimz

**Shared UI Infrastructure — Kurt**
- Web Toast notifications – Kurt
- Web Confirmation dialogs – Kurt
- Web Empty states – Kurt
- Web Skeleton loaders – Kurt
- Web Error boundary – Kurt
- Web DataTable (sortable/paginated) – **Ken** (core shared component)
- Web Form field kit – Kurt

### Mobile — Feature Assignment

**Authentication & Account Access — Jah**
- Mobile Login – Jah
- Mobile Registration (pending confirmation) – Jah
- Mobile Forgot/Recover password – Jah
- Mobile Reset password (deep-link) – **Ken** (security-sensitive)
- Mobile Email confirmation (deep-link) – Jah
- Mobile Logout / Logout everywhere – Jah
- Mobile Change password – Jah
- Mobile Account deletion – Jah

**Onboarding & Business Profile — Jimz**
- Mobile 3-step onboarding wizard – **Ken** (multi-step state, draft persistence)
- Mobile Business profile CRUD – Jimz
- Mobile Archive / restore business profile – Jimz

**Dashboard (Home) — Kurt**
- Mobile Dashboard summary – **Ken**
- Mobile Cashflow chart – Kurt
- Mobile Spending breakdown flip card – Kurt
- Mobile Greeting hero + mascot animation – **Ken** (custom animation engine)
- Mobile Home header – Kurt
- Mobile Quick actions grid – Kurt
- Mobile Pull-to-refresh – Kurt

**Records (Sales & Expenses) — Jah**
- Mobile Records list (search/filter/sort) – **Ken** (core filtering engine)
- Mobile Add expense – Jah
- Mobile Add sales reference – Jah
- Mobile Edit / delete record – Jah
- Mobile Category management – Jah
- Mobile Duplicate/anomaly review queue – **Ken**

**Receipt Scanning / OCR (Camera Pipeline) — Ken**
- Mobile Custom in-app receipt camera – Ken
- Mobile Crop editor – Ken
- Mobile Capture preview / section strip – Ken
- Mobile Multi-page receipt scan + polling – Ken
- Mobile Itemized receipt review & reconciliation – Ken

**CSV Import — Jimz**
- Mobile CSV import wizard – **Ken**
- Mobile CSV import entry from onboarding – Jimz

**AI Features — Ken**
- Mobile Ask FinSight (AI chat) – Ken
- Mobile AI-suggested categorization – Ken

**Insights & Analytics — Kurt**
- Mobile Expense Insight (Behavior) – **Ken**
- Mobile Spending Impact calculator – Kurt
- Mobile Recovery Target – **Ken** ("signature component")
- Mobile Segmented insight navigation – Kurt

**Notifications / Alerts — Jah**
- Mobile Notifications (alerts) list – Jah
- Mobile Unread badge on Home bell – Jah

**Navigation & App Shell — Jimz**
- Mobile Bottom tab nav + Scan quick-action button – **Ken**
- Mobile Stack navigators per tab – Jimz
- Mobile Auth deep-link interception – **Ken**
- Mobile Splash screen + font loading gate – Jimz
- Mobile Onboarding gate – Jimz

**Help & Legal — Kurt**
- Mobile FAQs – Kurt
- Mobile Tutorials – Kurt
- Mobile Contact us – Kurt
- Mobile Privacy / Terms – Kurt

**Profile / Account Settings — Jah**
- Mobile Profile editing – Jah
- Mobile "More" hub screen – Jah

**Shared UI System / Cross-Cutting Polish — Jimz**
- Mobile Design-token/theme system – **Ken** (centralized, consistency-lint enforced)
- Mobile Shared primitive component library – **Ken** (core shared component)
- Mobile Loading skeletons – Jimz
- Mobile Confirmation sheets – Jimz
- Mobile Empty states – Jimz
- Mobile Haptics – Jimz
- Mobile Reduced-motion accessibility support – Jimz
- Mobile Keyboard-aware forms – Jimz
- Mobile Swipeable list rows – Jimz

---

## Part 4 — Recommended Easy Tasks for Teammates

| Task | Assigned Member | Platform | Related Existing Feature | Difficulty | What the Teammate Needs to Do |
|---|---|---|---|---|---|
| Write and expand FAQ content | Jah | Web + Mobile | FAQs (Web §11, Mobile §11) | Easy | Draft additional Q&A entries based on common user questions; keep web/mobile copy in sync |
| Write tutorial step content / script placeholder videos | Jah | Mobile | Tutorials (Mobile §11.2) | Easy | Write clear step-by-step text for each tutorial card; optionally storyboard a short walkthrough video |
| Proofread legal pages (Privacy/Terms) | Jah | Web + Mobile | Privacy/Terms pages | Easy | Read through both platforms' legal text for typos, inconsistency, outdated info |
| Add password-strength indicator | Jah | Web + Mobile | Change Password (§1) | Easy | Add a simple visual strength meter component to the password field |
| Test and improve empty states | Jimz | Web + Mobile | Empty State component (Web §12, Mobile §13) | Easy | Go through every screen with no data (records, categories, notifications, businesses) and confirm/improve the empty-state message and icon |
| Test and polish loading skeletons | Jimz | Web + Mobile | Skeleton loaders | Easy | Compare skeleton shapes against actual loaded layouts; report/fix mismatches |
| Test swipe gestures on Records list | Jimz | Mobile | Records list, Flagged records (Mobile §4) | Easy | Test swipe-to-delete/resolve on multiple Android device sizes; report sensitivity issues |
| Verify theme/color contrast across pages | Jimz | Web | Theme switcher (Web §10) | Easy | Check Classic/Light/Dark themes on every page for readability issues |
| Add currency input formatting/masking | Jimz | Web + Mobile | Add expense/sales forms | Easy | Add thousands-separator formatting as the user types in amount fields |
| Test onboarding skip/resume flow | Kurt | Web + Mobile | Onboarding wizard (§2) | Easy | Walk through skip → resume → complete flow on both platforms; document any bugs |
| Test CSV import with real-world files | Kurt | Web + Mobile | CSV Import (§5/§6) | Moderate | Import various bank/POS CSV exports and document parsing issues (without touching detection logic) |
| Test notification mark-read/mark-all-read flows | Kurt | Web + Mobile | Notifications (§9) | Easy | Verify unread counts update correctly across bell, dropdown, and archive |
| Write/refine AI chat starter-prompt copy | Kurt | Web + Mobile | Ask FinSight (§8/§7) | Easy | Draft better starter-question suggestions per module (Dashboard, Expense Insight, etc.) — copywriting only, no logic changes |
| Test receipt scanning UX with real receipts | Kurt | Mobile | Receipt camera pipeline (§5) | Moderate | Scan a variety of real receipts, document confusing UI moments or unclear error states (no pipeline code changes) |

---

## Part 5 — Suggested Team Distribution

### Ken — Main Developer
Keep all technically difficult and system-critical work under Ken:
- Backend architecture, database schema, Prisma migrations
- Authentication/security architecture (password reset, session revocation, deep-link token handling)
- AI integration (Ask FinSight, category suggestion) — both platforms
- OCR/receipt-scanning pipeline (camera, edge detection, image quality, Tesseract/vision fallback, itemized reconciliation) — both platforms
- Financial analytics engine (Expense Behavior, Recovery Target, Spending Impact calculations)
- Anomaly/duplicate detection services (amount outlier, near-duplicate, recurring pattern, trend, velocity, behavioral novelty)
- CSV import parsing/detection logic (mixed-file heuristics)
- Core shared components (DataTable, design-token system, api.ts error handling)
- Deployment, CI, security hardening

### Jah
- Write and expand FAQ content (Web + Mobile)
- Write tutorial step content for Mobile Tutorials screen
- Proofread legal pages (Privacy/Terms) on both platforms
- Add password-strength indicator UI to Change Password forms

### Jimz
- Test and improve empty states across both platforms
- Test and polish loading skeletons
- Test swipe gestures on Mobile Records list
- Verify theme/color contrast across Web pages
- Add currency input formatting/masking to record forms

### Kurt
- Test onboarding skip/resume flow on both platforms
- Test CSV import with real-world files and document issues
- Test notification read/mark-all flows
- Write/refine AI chat starter-prompt copy
- Test receipt scanning UX with real receipts and document UI friction

---

## Final Summary Table

| Member | Assigned Features / Tasks | Platform | Difficulty | Contribution Type |
|---|---|---|---|---|
| Ken | Backend architecture, auth/security, AI integration, OCR/receipt pipeline, financial analytics, anomaly detection, CSV parsing logic, core shared components, deployment | Web/Mobile/Backend | Difficult | Main Development |
| Jah | FAQ content, tutorial content, legal page proofreading, password-strength indicator | Web/Mobile | Easy | Content / UI Improvements |
| Jimz | Empty-state testing/polish, skeleton verification, swipe-gesture testing, theme contrast checks, currency input formatting | Web/Mobile | Easy | UI / Testing / Improvements |
| Kurt | Onboarding flow testing, CSV import real-world testing, notification flow testing, AI chat prompt copy, receipt-scan UX testing | Web/Mobile | Easy–Moderate | Testing / QA / Copywriting |

---

## Notes on Methodology

This inventory was produced by directly reading the source code in `web/src/`, `mobile/src/`, and `backend/src/` — routes, controllers, services, pages, screens, and shared components — rather than relying on prior documentation claims. Every feature listed above was confirmed to have a wired route/screen, a real API call, and (where applicable) a backend controller/service actually implementing it. No stub or placeholder features were found on either platform; the only genuine gaps identified are **offline support** and **on-device OCR** (both explicitly acknowledged as future work in-app) and **tutorial videos** (step content exists, video content does not).
