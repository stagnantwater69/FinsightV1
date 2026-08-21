# Scorecard — FinSight Mobile

1. Good design is innovative — Score: 2/3
   Evidence: Recovery Meter's remaining-operating-days-adjusted daily target, AskFinSight's self-undermining "not AI-written" honesty framing, and the non-directive Spending Impact simulator (01-evidence.md Copy & Honesty) are genuine refinements of established bookkeeping/AI-assistant patterns, executed with restraint.
   Justification: Clear improvements over the generic pattern, but nothing in evidence supports the "unseen in 5+ peer products" bar required for a 3 — no competitive teardown was performed, so that claim can't be backed.

2. Good design makes a product useful — Score: 3/3
   Evidence: primary task (record a transaction, read financial health) completes in a single consolidated dashboard call (`DashboardScreen.tsx:38-41`) and a check-before-save receipt-scan flow; no decoy actions found anywhere in Copy & Honesty or Structural evidence.
   Justification: The duplicated-widget friction found elsewhere (segmented controls, add-patterns) is a recognition/consistency cost, not an added step or decoy on the primary task itself — the anchor for this principle is step-count/decoys specifically, which is clean.

3. Good design is aesthetic — Score: 2/3
   Evidence: 296 token-based spacing uses vs. ~74 hardcoded (mostly sub-8px micro-nudges), a 5-step named type scale with disciplined 12-15px clustering, and exactly one confirmed color-token drift bug (`RecoveryMeter.tsx:81` hardcoding `#e8efed` instead of `paper[200]`).
   Justification: The one real system leak (the drift bug) plus informal-but-consistent type extremes for title/hero cases reads as ≤2 minor inconsistencies, not a jarring violation — the widget-duplication problem is scored under #10 instead, where it more precisely belongs.

4. Good design makes a product understandable — Score: 1/3
   Evidence: 4 flagged jargon/unclear labels sit inside the app's flagship value proposition — "Recovery target," "Adjusted daily target" (RecoveryMeter.tsx:69), "Sales reference" (DashboardScreen.tsx:149) — and the same conceptual widget (segmented control) renders as 7 visually distinct implementations across screens (01-evidence.md Structural).
   Justification: More than "1 control needs a tooltip" (score 2) but short of "primary action unidentifiable" (score 0) — jargon in core-value copy plus broken recognition-over-recall across screens lands squarely at 2-3 unclear points, i.e. score 1.

5. Good design is unobtrusive — Score: 2/3
   Evidence: DRY `Card`/`Button` usage throughout, hand-built minimal SVG charts chosen explicitly to avoid a heavier charting library (charts.tsx:8-13), no decorative elements flagged as competing with content by any subagent.
   Justification: Nothing pushes this down, but there's no live render to confirm chrome fully "recedes" vs. merely "quiet" — genuine uncertainty, so the score rounds down to 2 rather than 3.

6. Good design is honest — Score: 3/3
   Evidence: zero inflated claims, zero dark patterns, zero label→behavior mismatches found across every screen's copy (01-evidence.md Copy & Honesty); AI-derived values are explicitly disclaimed ("not AI-written," "interpreted from the photo by AI") rather than oversold.
   Justification: Every claim, badge, and label maps 1:1 to actual behavior — the textbook case for a 3.

7. Good design is long-lasting — Score: 3/3
   Evidence: no subagent flagged any dated trend marker (no skeuomorphism, no fad gradients, no glassmorphism/neumorphism); the palette is a muted teal/ink/amber neutral system and charts are flat hand-built SVG shapes, not a trend-chasing chart library's default look.
   Justification: The anchor for a 3 is "no dated trend markers found" — that's exactly what the evidence shows, with no countervailing signal.

8. Good design is thorough down to the last detail — Score: 1/3
   Evidence: focus state is entirely unimplemented app-wide (zero `onFocus` handling found; every TextInput keeps a static border regardless of keyboard focus), and success feedback is missing on 4 of 7 major flows (Dashboard, Records list, Insights, Notifications) per 01-evidence.md Visual.
   Justification: Two states (focus, success) are missing systemically rather than "rough in one place" — matches "2-3 states missing" exactly, not the single-miss anchor for a 2.

9. Good design is environmentally friendly — Score: 2/3
   Evidence: charts avoid a heavy library by design, the idle shimmer self-stops once data loads, and the dashboard's own fetch is a single call — but `AccessibilityInfo.isReduceMotionEnabled` has zero matches repo-wide, and the auth→profile→categories→dashboard bootstrap chain is sequential, not `Promise.all`'d (01-evidence.md Weight & Friction).
   Justification: Motion is gated (no indefinite idle animation) but prefers-reduced-motion is confirmed entirely unrespected, which the anchor for a 3 explicitly requires — caps this at 2.

10. Good design is as little design as possible — Score: 1/3
    Evidence: 5 fully unused exported components sit dead in the codebase (`ExecutiveSummaryCard`, `Pill`, `Divider`, `SeriesDot`, `HeroFigure`), plus unused props (`Alert.action`, `Money.bare`/`decimals`, `RecoveryMeter.compact`), plus 7+ independently-styled reimplementations of the same segmented-control/pill affordance where one shared component would serve every case.
    Justification: Far exceeds the "≤2 removable elements" bar for a 2 — this is a clear "3-5 removable elements" case, arguably worse once the duplicate-widget count is added to the dead-component count.

**Total: 20/30. No principle scored 0.**
