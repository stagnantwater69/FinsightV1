import { Platform } from "react-native";
import { TAP } from "../theme/tokens";

/**
 * The minimum a control may measure, per platform.
 *
 * `TAP` (44) in theme/tokens.ts is Apple's floor. Android's is 48dp, and the
 * phones this app is actually for are Android almost without exception — so a
 * control built to 44 is built to the wrong number on the device it will be
 * used on. This is that number, resolved once.
 *
 * WHY IT IS NOT IN tokens.ts, RECONSIDERED AND DECIDED AGAIN. The original
 * reason was that tokens.ts was off-limits mid-run; that has stopped being
 * true, so the move was reopened and rejected on its merits:
 *
 *   1. TAP_FLOOR IS NOT A TOKEN. Everything in tokens.ts is a literal design
 *      value mirrored from the web app — a scale, not a decision. This is a
 *      runtime `Platform.select`, and its value differs per device. Putting it
 *      beside `TAP = 44` would make one of the two look like the real number
 *      when the point is that both are, on different phones.
 *   2. tokens.ts SITS BEHIND SHARED LOGIC. src/lib/confidenceBands.ts,
 *      authValidation.ts and conversationGroups.ts all import it, and all
 *      three are contract-tested against their web counterparts in
 *      tests/webParity.test.ts. An import of `react-native` in tokens.ts would
 *      put a native dependency behind modules whose whole purpose is being
 *      shareable. It was measured, and the source suite does currently survive
 *      it — but only because Vitest happens to elide the import, which is an
 *      accident of the bundler, not a property anyone chose. The guard in
 *      tests/touchTargets.test.ts now asserts tokens.ts imports nothing from
 *      react-native, so this is a rule rather than a hope.
 *
 * WHY IT IS NOT IN ui.tsx: a non-component export there costs every primitive
 * in the file its fast refresh. So it is its own module, which is also what
 * lets the camera chrome use it without importing the whole primitive set.
 *
 * THERE IS ONE FLOOR. If you find yourself needing a per-platform minimum,
 * import this one. Do not add a second next to it.
 *
 * The rule the guard test (tests/touchTargets.test.ts) enforces: a shared
 * control either measures at least this, or it carries a `hitSlop` that makes
 * up the difference. `TAP - something` is never the answer — that expression is
 * how 34-point chips and 36-point segments got written in the first place, each
 * one a deliberate-looking undercut of the constant that exists to prevent it.
 */
export const TAP_FLOOR = Platform.select({ android: 48, default: TAP });
