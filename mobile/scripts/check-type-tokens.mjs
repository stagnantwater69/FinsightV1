#!/usr/bin/env node
/**
 * Guards the typography tokens.
 *
 * WHY THIS EXISTS AND IS NOT A LINT RULE: the natural way to express this is
 * ESLint's `no-restricted-syntax`, and oxlint — which is what web already runs
 * in CI — does not implement that rule. The choice was to pull a second, much
 * heavier linter into mobile solely for one project-specific rule, or to write
 * the one rule. This is the one rule.
 *
 * It exists because TypeScript structurally cannot catch this class of drift:
 * `fontSize: 17`, `fontWeight: "600"` and `fontFamily: "Inter_500Medium"` are a
 * valid number and two valid strings. Nothing in typecheck or the test suite
 * had an opinion, which is how the app reached sixteen distinct type sizes and
 * twenty-one screens overriding the same token.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = join(fileURLToPath(new URL("../src", import.meta.url)));

/**
 * Sizes that are deliberately NOT in the type scale, with the reason each is
 * allowed to stay a bare number. Anything not listed here is a failure.
 *
 * These are per-file so that adding a new raw size somewhere else still fails
 * even if the same number is legitimately allowed elsewhere.
 */
const ALLOWED = [
  // Glyph sizing: these set the size of a character used as an icon (× close
  // controls, a numeric page badge), not of text. Borrowing a type-scale name
  // for them would make the scale mean two different things.
  { file: "components/ui.tsx", sizes: [20] },
  { file: "components/AskFinSight.tsx", sizes: [22] },
  { file: "components/HomeHeader.tsx", sizes: [9] },
  { file: "components/receipt-camera/CapturedSectionStrip.tsx", sizes: [9] },

  // The receipt-camera overlay. This text sits on live video and was tuned as
  // a set against a moving background; snapping it to the shared scale would
  // trade legibility exactly where legibility is hardest for tidiness.
  { file: "components/receipt-camera/CapturePreview.tsx", sizes: [11.5, 12.5] },
  { file: "components/receipt-camera/CameraControls.tsx", sizes: [11.5] },
  { file: "components/receipt-camera/CropEditor.tsx", sizes: [11.5, 12.5] },
  { file: "components/receipt-camera/CameraPermissionState.tsx", sizes: [13.5] },
  { file: "components/QuickActionMenu.tsx", sizes: [11.5] },
  { file: "components/ui.tsx", sizes: [13.5] },
  { file: "screens/InsightsScreens.tsx", sizes: [13.5, 10.5] },
];

const allowedFor = (rel) =>
  new Set(ALLOWED.filter((a) => a.file === rel).flatMap((a) => a.sizes));

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (/\.tsx?$/.test(full)) yield full;
  }
}

const failures = [];

for (const file of walk(SRC)) {
  const rel = relative(SRC, file);
  if (rel === "theme/tokens.ts") continue; // the scale itself

  const allowed = allowedFor(rel);
  const lines = readFileSync(file, "utf8").split("\n");

  lines.forEach((line, i) => {
    const at = `${rel}:${i + 1}`;

    for (const m of line.matchAll(/fontSize:\s*([0-9.]+)/g)) {
      const size = Number(m[1]);
      if (!allowed.has(size)) {
        failures.push(`${at}  fontSize: ${m[1]} — use a typeScale token, or add it to ALLOWED with a reason`);
      }
    }

    // Only the loaded faces render. A bare weight makes Android synthesize a
    // fake bold instead of selecting the real face, so the two platforms
    // disagree — this is the bug that shipped before the tokens existed.
    for (const m of line.matchAll(/fontWeight:\s*["']?(\w+)["']?/g)) {
      failures.push(`${at}  fontWeight: ${m[1]} — use a font.* family; a bare weight renders differently on Android`);
    }

    for (const m of line.matchAll(/fontFamily:\s*"([^"]+)"/g)) {
      failures.push(`${at}  fontFamily: "${m[1]}" — use the font.* token, not the face name`);
    }
  });
}

if (failures.length) {
  console.error(`\n✗ ${failures.length} typography token violation(s):\n`);
  failures.forEach((f) => console.error("  " + f));
  console.error("\nThe scale lives in src/theme/tokens.ts (typeScale) and the variants in src/components/ui.tsx.\n");
  process.exit(1);
}

console.log("✓ typography tokens clean");
