# Phase 7 — Final Verification & Re-score

Branch `feat/mobile-ui-refine`, six commits on top of `dc0df25`.

## Regression checklist — the three principles that scored 3/3

A refine pass most risks breaking what was already good. All three hold.

### #2 Useful — HOLDS
- [x] Dashboard fires exactly **one** API call for its own render — `DashboardScreen.tsx:37`, `/dashboard/summary`. Phase 6b changed the *bootstrap* chain; the dashboard's own fetch was not fanned out. `DashboardScreen.tsx` was never edited in Phase 6.
- [x] Scan Receipt still requires explicit confirmation before saving OCR'd values — `buildReceiptConfirmPayload` still gated behind the "Check the details" review panel and an explicit `confirm()`.
- [x] No new steps in record-an-expense. The chip migration was presentational; selection logic stayed at call-sites.

### #6 Honest — HOLDS
- [x] No superlatives in user-facing strings. Two grep hits, both benign: `AskFinSight.tsx:159` uses "instantly" in a *code comment* about animation timing; `MoreScreen.tsx:124` is the brand tagline "FinSight — see smarter, spend wiser", which is a value proposition rather than a functional claim, and predates this work. **Recorded as a known-good exception** so it is not rediscovered as a regression.
- [x] AI disclaimers intact on every live surface — `RecordsScreens.tsx:1405-1406` ("interpreted from the photo by AI... treat them as a first guess"), `:1420`, `RecordOrigin.tsx:110`, `AskFinSight.tsx:346` ("not by AI").
  - Note: the string "not AI-written" no longer appears. It lived on `ExecutiveSummaryCard`, which had **zero call-sites** and was deleted in Phase 1 — it was never rendered to a user. Not a regression.
- [x] Every label added in Phase 3 maps 1:1 to actual behavior. The large-expense threshold copy was corrected against the real server formula (`expectedMonthlyExpenses × percent/100`) after the plan described a rule the code does not implement.
- [x] No confirmshaming — destructive dialogs still use neutral pairs ("Keep it" / "Delete", "Cancel" / "Archive").

### #7 Long-lasting — HOLDS
- [x] Exactly **one** shadow declaration app-wide (`ui.tsx:637`, `styles.card`). `ExecutiveSummaryCard`'s second one went with it in Phase 1 and nothing added one back — including the two new chip primitives.
- [x] Palette unchanged. `git diff` on `mobile/src/theme/tokens.ts` across the whole branch is **empty**.
- [x] No trend markers in the new primitives — no gradients, blur, glass, or skeuomorphism. (One grep hit is a comment referencing the *Goal-Gradient* UX law, not a visual gradient.)

## Full-suite verification

| App | Result |
|---|---|
| mobile typecheck | clean |
| mobile tests | **10 files, 73 tests passing** (was 5 files / 56) |
| web typecheck | clean |
| web tests | 4 files, 68 tests passing |
| backend tests | **not run — requires a live Postgres + `.env.test`**, unavailable in this environment |

**Scope:** `git diff --stat dc0df25..HEAD -- web/ backend/` is **empty**. This branch touched only `mobile/` and this audit directory. The backend suite not running is an environment limitation, not a risk, since no backend file was modified.

## Static guards added by this work

Five new test files, each verified **non-vacuous** by running its rule against the pre-change source:

| Guard | Catches | Proven against |
|---|---|---|
| `chipConsistency.test.ts` | hand-rolled selection chips outside `ui.tsx` | 4 offenders pre-Phase-2 |
| `successFeedback.test.ts` | an API write that leaves the screen silently | 4 offenders pre-Phase-3 |
| `pressableRoles.test.ts` | a `Pressable` a screen reader announces as plain text | 4 offenders pre-Phase-5 |
| `flash.test.ts` | one-shot message semantics | unit-tested directly |
| `useReducedMotion.test.ts` | subscription lifecycle + two after-teardown races | **mutation-tested** — 4 distinct mutations each fail it |

Two of these guards found real bugs *after* being written: `successFeedback`'s write pattern abbreviated `delete` to `del`, so a trailing `\b` never matched `api.delete` and every delete flow was exempt — fixing it immediately caught record deletion navigating away in silence. And `chipConsistency` was over-broad, flagging a rounded *input* as a chip; it now keys on a brand background rather than any brand mention.

## Re-score

| # | Principle | Before | After | What moved it |
|---|---|---|---|---|
| 1 | innovative | 2 | **2** | Unchanged. A refine polishes; it does not advance the form. |
| 2 | useful | 3 | **3** | Maintained — verified above. |
| 3 | aesthetic | 2 | **2** | The token-drift bug is fixed, but the type scale still carries 11 distinct sizes with one-off extremes. Normalizing it was explicitly out of scope, so this could not fully move. |
| 4 | understandable | 1 | **2** | Four flagship terms now explain themselves; ten selection controls became two consistent ones. Held at 2 rather than 3 because the terms still needed four explanatory lines — the naming itself is not self-evident. |
| 5 | unobtrusive | 2 | **2** | Unchanged. The original 2 reflected uncertainty from having no live render; that uncertainty remains. |
| 6 | honest | 3 | **3** | Maintained — verified above. |
| 7 | long-lasting | 3 | **3** | Maintained — verified above. |
| 8 | thorough | 1 | **3** | All six states now present and considered. Focus went from zero implementations to every input; success feedback covers all five save flows plus delete. |
| 9 | environmentally friendly | 2 | **3** | Reduced motion is respected — the specific gap that capped this at 2. Bootstrap also lost two serialized round trips. **Caveat below.** |
| 10 | as little design as possible | 1 | **3** | Five dead components, three unused props, and the duplication all resolved. **Caveat below.** |

**Total: 20/30 → 26/30**

### Two scores worth disagreeing with

- **#9 at 3** assumes the reduced-motion fix clears the bar. A stricter reading would note the app has **no dark mode at all** — the principle's own anchor lists "dark mode honored" for a 3. It was never in scope here and never flagged in the original audit. If you weight it, #9 is a 2 and the total is 25.
- **#10 at 3** carries one deliberate exception: `Money.bare` and `Money.decimals` remain unused by any caller. They were kept because they are the only route to `formatMoney` behavior that `money.test.ts` covers — removing them would orphan tested logic. Under a strict "removing any element breaks the task" reading, that is a 2.

## Mandatory live-device QA before ship

Nothing below is verifiable from source. This repo has **no component-render harness** (no testing-library, no react-test-renderer), so every UI change here is proven to compile and to satisfy static rules — not to look or behave correctly.

1. **Keyboard behavior across all nine forms — highest risk in the plan.** Focus chaining, keyboard avoidance, and focus-scroll differ per platform. Start with `ScanReceiptScreen` (longest screen; `padding` vs `height` behave differently there on iOS).
2. **iOS numeric keypads have no return key** — on amount and threshold fields the hand-off and return-key submit are Android-only. No source change fixes this; the Save button remains the reliable path. Confirm that reads acceptably.
3. **VoiceOver / TalkBack traversal**, including whether the new section headers give a coherent jump order, and whether `RecordCard`'s composed label collapses the card into one element as intended.
4. **Reduce Motion system toggle** on both platforms — confirm the skeleton rests static and the Ask sheet still opens *and closes*.
5. **Cold start** — measure the actual saving from Phase 6b (inferred from the call graph, not measured) and check the splash→app handoff for a one-frame gap. Re-test login, logout, token refresh, and first-run-with-no-business-profile.
6. **Chip wrapping** at narrow widths with long Filipino category names.
7. Three deliberate visual normalizations to eyeball: `CategoryPicker` chips 36→34px with 13→12px text, Dashboard segments now equal-width, `InsightTabs` 2px shorter.

## Deliberately not done

Named so they are not rediscovered as oversights: information architecture and navigation; token *values* (palette, type scale, spacing scale); new screens or features; a component-testing framework; `react-native-reanimated` and the `ReanimatedSwipeable` migration (large native dependency — logged as tech debt); relocating `Field` from `AuthScreens.tsx` to `ui.tsx` (mechanical follow-up); dark mode.
