---
name: finsight-ui-polish
description: Use when writing or changing UI code in web/src or mobile/src, designing a new screen/component, or asked to improve/polish/redesign FinSight's UI/UX — before choosing any color, font size, shadow, animation, or illustration.
---

# FinSight UI Polish

## Overview

FinSight already has a deliberate, non-generic design system — a teal brand
scale, a rare warm-amber accent, theme-driven neutrals, a strict type stack,
green-tinted elevation, named motion curves, and a full mascot illustration
library. The "looks like a common AI-generated UI" problem is not a missing
design system — it's an agent, under time pressure, reaching past that system
for defaults (Tailwind indigo, raw gray hex, `dark:` variants, a generic
rounded-card-with-shadow, a stock icon) instead of using what's already there.

This skill's job: make the existing system the path of least resistance, and
name the specific defaults that signal drift.

**Pair with `impeccable`** (already installed): impeccable answers "does this
look intentional and high-end, generically." This skill answers "does it look
intentional and high-end *as FinSight, specifically*." Run impeccable's
critique lens, then check the result against the tokens below.

## Before writing any UI code

1. Read the authoritative token source, don't rely on memory of it:
   - Web: `web/tailwind.config.js` (color/type/shadow/motion tokens) +
     `web/src/index.css` (the CSS custom properties `ink`/`paper`/`tint`/
     `tone`/`edge` resolve to per theme).
   - Mobile: `mobile/src/theme/tokens.ts`.
2. Find the nearest existing component that does something similar and match
   its patterns — a card, a status chip, an empty state, a stat tile. FinSight
   already has one; don't invent a second, slightly different version (same
   rule this codebase applies to business logic — see `CLAUDE.md`).
3. If a change needs to step outside the token system, that's allowed but
   must be a deliberate, stated reason in the diff/PR — not a silent default.

## Quick reference — reach for this, not that

| Need | Use | Not |
|---|---|---|
| Any brand color | `brand-*` (teal scale) | Tailwind `indigo-*`/`purple-*`/`blue-*` |
| An emphasis/CTA color | `accent-*` (amber) — **only** the Recovery Meter and primary CTAs | `accent-*` anywhere else in general chrome |
| Body/heading text, backgrounds | `ink-*` / `paper-*` (theme-driven) | raw `slate-*`/`gray-*` hex, or a `dark:` variant at the call site |
| A status chip (success/warning/danger/info) | the matched triple: `tint-*` (wash) + `tone-*` (text) + `edge-*` (hairline) | a literal `bg-rose-50 text-rose-800 ring-rose-200`-style triple |
| Heading font | Sora, **18px and above only** | Sora below 18px, or a default system heading font |
| Body/UI text | Inter | default sans stack |
| Any currency figure | IBM Plex Mono — no exceptions | proportional/sans figures for money |
| Text size (mobile) | `typeScale.*` role name (e.g. `bodySm`, `title`) | a raw `fontSize` number (enforced by `mobile/scripts/check-type-tokens.mjs`, which also covers `App.tsx`) |
| Card/surface shadow | the existing green-tinted `boxShadow` scale (`sm`/`md`/`lg`) | a generic neutral-black box-shadow utility |
| Entrance/transition motion | the named keyframes (`pop-in`, `fade-up`, `slide-up`, `badge-in`, `pop-down`, `toast-in`) or `transitionTimingFunction.shell` | default `ease-in-out`, no transition, or an ad-hoc one-off keyframe |
| Empty/loading/onboarding/auth state illustration | look up the mapped mascot pose in `docs/mascot-scenario-library.md` first (assets in `web/public/mascot/`, `mobile/assets/mascot/`) | inventing a generic icon or stock illustration |

## Common mistakes

| Mistake | Why it's the "AI slop" tell | Fix |
|---|---|---|
| `bg-indigo-500` / `text-purple-600` etc. | Default Tailwind palette is the single most recognizable generic-AI-UI signal | `bg-brand-500` or the nearest token |
| Amber used on a badge, icon, or link outside the two sanctioned spots | Dilutes the one color meant to mean "this matters" | Use `brand-*` or a `tint/tone/edge` status token instead |
| `dark:text-gray-300` written directly on an element | Bypasses the theme system; breaks Light theme (3 themes exist, not 2) | Use `text-ink-*` / `bg-paper-*`, which already resolve per theme |
| A price/total rendered in the default sans font | Breaks the one hard typographic rule in this codebase | Wrap in the mono font token |
| A new empty-state SVG/icon drawn from scratch | Skips the mascot system that already maps this exact state | Check `docs/mascot-scenario-library.md` for the pose first |
| `rounded-2xl shadow-lg` slapped on every container uniformly | Generic "AI dashboard" sameness — no hierarchy | Use `radius`/`boxShadow` steps deliberately, matched to the surface's actual elevation in the layout |
| A raw `fontSize: 13` in a mobile style object | Silently drifts from the type scale until the checker catches it (or doesn't, if outside its scan root) | Use `typeScale.*`; run `node mobile/scripts/check-type-tokens.mjs` |

## Note on scope

This is a project-specific reference skill, not a cross-project discipline
skill — it wasn't run through adversarial pressure-testing against a baseline
(see `writing-skills` for when that's warranted). If a future review finds an
agent rationalizing past one of these rules under pressure, add the specific
rationalization to the mistakes table above rather than softening the rule.
