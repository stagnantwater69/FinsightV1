#!/usr/bin/env node
// Tripwire for web/mobile API-contract drift: web/src/lib/types.ts and
// mobile/src/lib/types.ts are hand-kept in sync (no shared codegen yet), and
// that sync has silently broken before — see the audit that found mobile
// missing RecordOriginItem/RecordOrigin/RecordDetail entirely.
//
// This does NOT type-check field shapes. It only catches the loudest signal:
// an exported type/interface that exists on one side and not the other.
// Deliberate one-sided types (platform-only helpers) can be exempted below.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const WEB_TYPES = path.join(repoRoot, "web/src/lib/types.ts");
const MOBILE_TYPES = path.join(repoRoot, "mobile/src/lib/types.ts");

// Names intentionally present on only one side — document why when adding one.
const EXEMPT = new Set([]);

function exportedNames(filePath) {
  const src = readFileSync(filePath, "utf8");
  const names = new Set();
  const re = /^export\s+(?:interface|type)\s+([A-Za-z0-9_]+)/gm;
  let match;
  while ((match = re.exec(src)) !== null) {
    names.add(match[1]);
  }
  return names;
}

const webNames = exportedNames(WEB_TYPES);
const mobileNames = exportedNames(MOBILE_TYPES);

const onlyInWeb = [...webNames].filter((n) => !mobileNames.has(n) && !EXEMPT.has(n));
const onlyInMobile = [...mobileNames].filter((n) => !webNames.has(n) && !EXEMPT.has(n));

if (onlyInWeb.length === 0 && onlyInMobile.length === 0) {
  console.log(`check-type-parity: ${webNames.size} exported types match on both sides.`);
  process.exit(0);
}

if (onlyInWeb.length > 0) {
  console.error(`Types exported from web/src/lib/types.ts but missing from mobile/src/lib/types.ts:`);
  for (const n of onlyInWeb) console.error(`  - ${n}`);
}
if (onlyInMobile.length > 0) {
  console.error(`Types exported from mobile/src/lib/types.ts but missing from web/src/lib/types.ts:`);
  for (const n of onlyInMobile) console.error(`  - ${n}`);
}
console.error(
  "\nIf this is intentional (a platform-only type), add it to the EXEMPT set in " +
    "scripts/check-type-parity.mjs with a comment explaining why. Otherwise, port " +
    "the missing type across — see CLAUDE.md's hard rules and the mobile/types.ts " +
    "banner comment for the sync convention.",
);
process.exit(1);
