# FinSight Design System

## Direction

FinSight is a calm financial field guide: clear enough for daily operations, warm enough to reduce anxiety, and specific enough to avoid generic fintech styling. The visual world combines trustworthy ledger precision with the forward movement of a financial trail. Public surfaces may be editorial and expressive; authenticated surfaces favor hierarchy, speed, and evidence.

## Cross-platform contract

Uniformity means shared identity, terminology, hierarchy, component semantics, status meanings, formatting, and feedback. It does not mean pixel-identical screens. Web uses persistent navigation, keyboard behavior, tables, and wide comparisons. Mobile uses native stacks and tabs, safe areas, haptics, lists, sheets, and camera-first flows.

## Color roles

- Emerald/teal is the brand and interactive family.
- Mint and cream create warmth and separation without washing out the data.
- Amber is scarce: primary calls to action and the adjusted recovery target only.
- Good, warning, serious, and critical retain their established semantic hues and always include an icon or written label.
- Components consume semantic roles, never one-off literal colors. Fixed artwork/camera colors are documented exceptions.
- Light, dark, and system-resolved themes are first-class and must be checked together.

The source of truth remains the implemented token systems in `web/src/index.css`, `web/tailwind.config.js`, `mobile/src/theme/palette.ts`, and `mobile/src/theme/tokens.ts`.

## Typography

- Web wordmark: Cinzel Bold (700), uppercase FINSIGHT with moderate tracking. Gold on the emerald sidebar; theme-aware dark lettering on pale surfaces. Reserve this face for the brand name beside the mascot.
- Web: Sora for high-value display moments and major titles; Inter for interface copy, labels, controls, explanations, and everyday amounts with tabular numerals.
- Mobile: IBM Plex Sans for interface copy and headings. Regular 400 supports body copy, Medium 500 labels, SemiBold 600 controls and section titles, and Bold 700 major titles. Its compact letterforms and related Mono family suit the mobile financial field guide.
- IBM Plex Mono: mobile peso amounts and financial comparisons, plus compact axes and dense measurement contexts. Preserve aligned digits and the existing money formatting.
- Use semantic type roles. Avoid local sizes when an existing role fits.
- Keep readable prose near 65–75 characters per line and allow mobile text scaling without clipping.

## Shape, depth, and spacing

- Cards use restrained 12–16px-equivalent radii; pills belong to compact controls and tags.
- Use either a border or a soft elevation cue as the primary separator, not both at full strength.
- Group related elements tightly and separate distinct tasks generously.
- Avoid nested-card and equal-card grids when typography, alignment, or whitespace can express the structure.
- Preserve a 44px web, 48dp Android, and 44pt iOS minimum interactive target.

## Signature elements

The financial trail is a line or progression that shows records becoming understanding. Use it in the landing story, onboarding, receipt/import progress, and recovery journeys. It must communicate sequence or movement rather than becoming wallpaper.

Fin, the owl mascot, appears for guidance, recovery, encouragement, and meaningful milestones. It does not decorate every heading or compete with financial evidence.

## Components

Both platforms maintain equivalent semantics for buttons, fields, money, cards/panels, status pills, callouts, skeletons, empty states, progress, dialogs/sheets, feedback messages, chart frames, filters, and page/screen headers. Platform rendering follows native expectations.

Primary actions use amber with dark ink. Brand actions use teal. Destructive actions use the critical semantic role and name the affected object and consequence.

## Content and data

- Use sentence case and action-first labels.
- Explain accounting, OCR, and AI terms in plain language.
- Use Philippine peso formatting and locale-safe dates consistently.
- Name the source, business, and time range behind consequential insights.
- Label illustrative data and never invent testimonials, adoption numbers, accuracy rates, or business outcomes.
- Loading, empty, partial, offline, validation, permission, error, success, and destructive states are designed content—not afterthoughts.

## Motion and feedback

Motion explains hierarchy, state change, or progress. Operational transitions remain brief and interruptible. Richer motion is reserved for landing and onboarding. Reduced-motion preferences replace large movement with a crossfade or immediate state change.

Every mutation confirms what changed. Long-running OCR/import work shows its current phase and recovery path. Errors preserve user input and state what happened and what the user can do next.

## Accessibility

- Web: semantic landmarks and headings, visible focus, keyboard operation, route/status announcements, correctly associated fields, and focus restoration.
- Mobile: accessible names/roles/states, logical traversal, dynamic text, safe-area and keyboard behavior, native back handling, and screen-reader-friendly sheets/dialogs.
- Charts provide exact values and a textual summary. Color is never the only carrier of meaning.
- Contrast targets are 4.5:1 for normal text and 3:1 for large text and UI boundaries.

## Surface character

- Landing/public: editorial rhythm, truthful product demonstrations, bold hierarchy, selective bento composition, and one dominant conversion path.
- Authentication/onboarding: confidence, minimal distraction, clear recovery, and short activation paths.
- Dashboard/records: dense but calm, with one focal decision and strong numeric alignment.
- Scan/import: visible sequence, evidence beside corrections, clear confidence, and resilient recovery.
- Insights/recovery: summary, evidence, explanation, action, then methodology.
- Settings/help/legal: familiar platform patterns, readable grouping, and predictable wayfinding.

## Anti-patterns

No generic fintech gradients, fabricated proof, decorative glass, gradient text, card soup, color-only statuses, emoji icons, arbitrary one-off styles, squeezed desktop tables on phones, or mascot overuse. Do not change financial calculations or backend behavior as incidental design work.
