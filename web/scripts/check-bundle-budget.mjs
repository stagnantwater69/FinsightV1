#!/usr/bin/env node
// Bundle-size tripwire for web/dist/assets — run after `vite build`.
//
// Context: an audit of production output found a few JS chunks in the
// 250-346 KB (raw, pre-gzip) range — a shared auth/API chunk (supabase-js +
// axios), and the recharts-backed Dashboard/ExpenseInsight charting chunk.
// Investigating showed both are legitimate vendor weight already deferred
// as well as this codebase reasonably can:
//   - The charting chunk (recharts + DonutChart) only loads when a signed-in
//     user visits /dashboard or /insights/expense-behavior — App.tsx already
//     lazy-loads every authenticated page (see the CODE SPLITTING comment
//     there), so it never touches the landing/login/register first paint.
//   - The auth/API chunk (@supabase/supabase-js + axios) is pulled in by
//     AuthContext, which every route needs (even the public ones resolve
//     "am I logged in?" on mount) — there's no page that can defer it.
// Neither is a bug to fix by lazy-loading harder; this script exists so a
// *regression* — a new heavy dependency landing in a chunk that used to be
// small, or a lazy import accidentally becoming eager — fails CI instead of
// silently shipping.
//
// Thresholds (raw bytes, i.e. before gzip/brotli — what the browser has to
// parse/execute, and the more conservative number to gate on):
//   - ERROR  > 400 KB: fails the check. Today's largest chunk is ~346 KB, so
//     400 KB leaves headroom for normal growth while still catching a chunk
//     that roughly doubles in size unnoticed.
//   - WARN   > 300 KB: does not fail the check, just prints a note. The two
//     known-heavy vendor chunks (auth/API ~252 KB, charting ~336 KB) sit
//     either side of this line today; the warning is a nudge to look again
//     before it becomes a 400 KB error, not a gate to route around.
//
// Only checked against web/dist/assets/*.js — CSS and font assets have very
// different size/caching characteristics and are not what this audit was
// about.

import { readdirSync, statSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const webRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const assetsDir = path.join(webRoot, "dist", "assets");

const ERROR_THRESHOLD_BYTES = 400 * 1024;
const WARN_THRESHOLD_BYTES = 300 * 1024;

if (!existsSync(assetsDir)) {
  console.error(
    `check-bundle-budget: ${path.relative(webRoot, assetsDir)} does not exist. ` +
      `Run "npm run build --prefix web" first.`,
  );
  process.exit(1);
}

const jsFiles = readdirSync(assetsDir)
  .filter((name) => name.endsWith(".js"))
  .map((name) => {
    const filePath = path.join(assetsDir, name);
    return { name, bytes: statSync(filePath).size };
  })
  .sort((a, b) => b.bytes - a.bytes);

if (jsFiles.length === 0) {
  console.error(
    `check-bundle-budget: no .js files found in ${path.relative(webRoot, assetsDir)} — ` +
      `did the build actually emit output?`,
  );
  process.exit(1);
}

// KiB (1024-based), not Vite's own decimal "kB" in its build report — the
// two numbers for the same file will differ slightly (e.g. Vite prints
// 346.3 kB where this prints 338.2 KiB for the same bytes). Both are
// correct; they're just different units.
function kb(bytes) {
  return `${(bytes / 1024).toFixed(1)} KiB`;
}

const errors = [];
const warnings = [];

for (const { name, bytes } of jsFiles) {
  if (bytes > ERROR_THRESHOLD_BYTES) {
    errors.push({ name, bytes });
  } else if (bytes > WARN_THRESHOLD_BYTES) {
    warnings.push({ name, bytes });
  }
}

console.log(`check-bundle-budget: inspected ${jsFiles.length} chunk(s) in ${path.relative(webRoot, assetsDir)}`);
console.log(`  largest: ${jsFiles[0].name} (${kb(jsFiles[0].bytes)})`);

if (warnings.length > 0) {
  console.warn(
    `\nWARN — ${warnings.length} chunk(s) over ${kb(WARN_THRESHOLD_BYTES)} (not a failure, just a nudge to look again):`,
  );
  for (const { name, bytes } of warnings) {
    console.warn(`  - ${name}: ${kb(bytes)}`);
  }
}

if (errors.length > 0) {
  console.error(
    `\nERROR — ${errors.length} chunk(s) over the ${kb(ERROR_THRESHOLD_BYTES)} budget:`,
  );
  for (const { name, bytes } of errors) {
    console.error(`  - ${name}: ${kb(bytes)}`);
  }
  console.error(
    "\nIf this growth is expected (a genuinely new heavy dependency), raise " +
      "ERROR_THRESHOLD_BYTES in web/scripts/check-bundle-budget.mjs with a comment " +
      "explaining why, rather than silently ignoring the regression. If it's not " +
      "expected, check whether the new code landed in an eagerly-imported chunk " +
      "(App.tsx's route table) when it could be lazy-loaded instead.",
  );
  process.exit(1);
}

console.log("\ncheck-bundle-budget: all chunks within budget.");
process.exit(0);
