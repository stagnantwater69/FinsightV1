# Product

<!-- impeccable:product-schema 1 -->

## Platform

adaptive

## Users

FinSight primarily serves Philippine small-business owners who record daily sales and expenses, often capture receipts on an Android phone, and use a browser for deeper review and planning. Users may have limited accounting expertise, intermittent connectivity, older devices, and little time for bookkeeping.

## Product Purpose

FinSight turns sales, expenses, receipts, and imported transaction records into understandable financial monitoring. Success means an owner can maintain reliable records, recognize spending patterns and risks, understand recovery targets, and act with confidence without needing accounting or AI expertise.

## Positioning

FinSight connects everyday record capture with explainable, business-scoped insights. Its value is not generic bookkeeping or a generic chatbot: explanations and recommendations are grounded in the active business's own records, with source provenance, confidence, review, and confirmation kept visible.

## Operating Context

Owners move between quick mobile capture and broader web review. Core workflows include business setup and switching, manual sales and expense entry, receipt scanning and correction, CSV import, record and duplicate review, dashboard monitoring, spending-impact simulation, recovery planning, notifications, and questions through Ask FinSight.

## Capabilities and Constraints

- Single owner role; no administrator or staff-management surface.
- Web is React/Vite; mobile is React Native/Expo with Android-first receipt capture.
- PostgreSQL/Supabase ownership isolation and server-side financial calculations must not be weakened by interface work.
- Web and mobile maintain feature and terminology parity while using platform-native navigation and controls.
- Receipt extraction and AI results can be incomplete or uncertain and must be presented honestly.
- Mobile camera, permission, and lifecycle behavior requires physical-device verification.
- Filipino/Tagalog localization is an open release decision; layouts and strings should be prepared for it without claiming current support.

## Brand Commitments

The product name is FinSight. Its established identity uses an owl mascot named Fin, emerald/teal brand colors, mint and cream supporting surfaces, a rare amber accent, and a financial-trail motif. The voice is calm, practical, encouraging, and plain-spoken. The identity should become more coherent and distinctive, not be replaced.

## Evidence on Hand

- Implemented product flows and truthful interface examples in `web/src/` and `mobile/src/`.
- Existing palette, theme, component, icon, and typography systems in `web/src/index.css`, `web/tailwind.config.js`, `web/src/components/`, `mobile/src/theme/`, and `mobile/src/components/ui.tsx`.
- Owl and application artwork in `web/public/` and `mobile/assets/`, with provenance notes in `mobile/assets/README.md`.
- Automated test suites and internal acceptance reports in `docs/`.
- OCR evaluation evidence is largely synthetic and must never be presented as representative real-receipt accuracy.
- No verified customer testimonials, customer counts, usage totals, or production outcome claims are available.

## Product Principles

1. Make the owner's next decision clearer, not merely the interface prettier.
2. Preserve trust through truthful claims, visible provenance, understandable calculations, and honest uncertainty.
3. Make frequent capture fast on mobile and deeper comparison efficient on web.
4. Use one product language and semantic system across platforms while respecting native conventions.
5. Preserve work and provide a recovery path when validation, connectivity, permissions, AI, or OCR fails.

## Accessibility & Inclusion

Web targets WCAG 2.2 AA. Mobile supports scalable text, screen-reader semantics, safe areas, platform back behavior, reduced motion, and at least 48dp Android / 44pt iOS targets. Status must never rely on color alone. Financial charts require accessible summaries and exact values outside the graphic.
