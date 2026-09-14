#!/usr/bin/env node
// Tripwire for web/mobile API-contract drift. The two clients hand-copy the
// same server contracts (no shared codegen yet), and that copying has silently
// broken before: see the audit that found mobile missing
// RecordOriginItem/RecordOrigin/RecordDetail entirely, and the Phase 2 review
// that found the receipt-scan contracts living outside this script's reach.
//
// This does NOT type-check field shapes. It only catches the loudest signal:
// an exported type/interface that exists on one side and not the other.
//
// Three lists per group:
//   - web/mobile: the files whose exported names are compared.
//   - exempt: names deliberately present on only one side (platform-only UI
//     state or helpers). Each entry carries its reason.
//   - knownDrift: names that ARE a contract mismatch today, recorded here so
//     the script still passes while the owning client fixes them. They are
//     printed on every run and the script FAILS if an entry goes stale (the
//     name now exists on both sides), so this list can only shrink.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const GROUPS = [
  {
    name: "shared API types",
    web: ["web/src/lib/types.ts"],
    mobile: ["mobile/src/lib/types.ts"],
    exempt: {
      // Mobile-only: backend/src/routes/dashboard.routes.ts exposes GET
      // /dashboard/cashflow (backend/src/services/dashboard.service.ts) and
      // mobile's DashboardScreen/charts.tsx actually renders it. Web has no
      // code path that calls this endpoint, so there's nothing on the web side
      // to keep these in sync with; porting them would be dead types.
      CashflowGranularity: "mobile-only: web never calls GET /dashboard/cashflow",
      CashflowPoint: "mobile-only: web never calls GET /dashboard/cashflow",
      DashboardCashflow: "mobile-only: web never calls GET /dashboard/cashflow",
    },
    knownDrift: {},
  },
  {
    name: "receipt-scan contract",
    web: ["web/src/pages/scanReceipt/types.ts"],
    mobile: [
      "mobile/src/screens/records/scanReceipt/types.ts",
      // Mobile keeps the duplicate-candidate contract in its own module; web
      // keeps the same names in scanReceipt/types.ts.
      "mobile/src/screens/records/scanReceipt/duplicateReview.ts",
    ],
    exempt: {
      // Web-only screen state, never sent to or received from the server.
      AddedItem: "web-only: client-side line the owner adds before Confirm",
      Split: "web-only: per-category split entry state on the review form",
      Origin: "web-only: read/derived/missing/edited badge state per field",
      ScanStage: "web-only: progress-stage union for the upload UI",
      ReceiptPageQuality: "web-only: alias of ScanResult['pageQualities'][number], not a separate contract",
      // Mobile-only capture-session and review-notice state.
      CapturedPage: "mobile-only: an unsent photograph in the capture session",
      ReviewNotice: "mobile-only: rendered warning row derived from server warnings",
    },
    knownDrift: {},
  },
  {
    name: "receipt provider consent",
    web: ["web/src/lib/receiptProviderConsent.ts"],
    mobile: ["mobile/src/lib/receiptProviderConsent.ts"],
    exempt: {},
    knownDrift: {},
  },
];

function exportedNames(relativePaths) {
  const names = new Set();
  const re = /^export\s+(?:interface|type)\s+([A-Za-z0-9_]+)/gm;
  for (const relativePath of relativePaths) {
    const src = readFileSync(path.join(repoRoot, relativePath), "utf8");
    let match;
    while ((match = re.exec(src)) !== null) {
      names.add(match[1]);
    }
  }
  return names;
}

let failed = false;

for (const group of GROUPS) {
  const webNames = exportedNames(group.web);
  const mobileNames = exportedNames(group.mobile);
  const exempt = new Set(Object.keys(group.exempt));
  const drift = group.knownDrift;

  const onlyInWeb = [...webNames].filter((n) => !mobileNames.has(n) && !exempt.has(n));
  const onlyInMobile = [...mobileNames].filter((n) => !webNames.has(n) && !exempt.has(n));
  const matched = [...webNames].filter((n) => mobileNames.has(n)).length;

  const staleDrift = Object.keys(drift).filter((n) => webNames.has(n) && mobileNames.has(n));
  const newInWeb = onlyInWeb.filter((n) => !(n in drift));
  const newInMobile = onlyInMobile.filter((n) => !(n in drift));
  const recordedDrift = [...onlyInWeb, ...onlyInMobile].filter((n) => n in drift);

  console.log(
    `check-type-parity [${group.name}]: ${matched} exported types match on both sides` +
      (recordedDrift.length > 0 ? `, ${recordedDrift.length} recorded drift entries still open.` : "."),
  );
  for (const n of recordedDrift) {
    console.log(`  drift: ${n}: ${drift[n]}`);
  }

  if (staleDrift.length > 0) {
    failed = true;
    console.error(`\n[${group.name}] knownDrift entries now present on both sides, remove them from scripts/check-type-parity.mjs:`);
    for (const n of staleDrift) console.error(`  - ${n}`);
  }
  if (newInWeb.length > 0) {
    failed = true;
    console.error(`\n[${group.name}] exported from ${group.web.join(", ")} but missing from ${group.mobile.join(", ")}:`);
    for (const n of newInWeb) console.error(`  - ${n}`);
  }
  if (newInMobile.length > 0) {
    failed = true;
    console.error(`\n[${group.name}] exported from ${group.mobile.join(", ")} but missing from ${group.web.join(", ")}:`);
    for (const n of newInMobile) console.error(`  - ${n}`);
  }
}

if (!failed) {
  process.exit(0);
}

console.error(
  "\nIf this is intentional (a platform-only type), add it to that group's exempt " +
    "table in scripts/check-type-parity.mjs with a reason. Otherwise, port the " +
    "missing type across, see CLAUDE.md's hard rules and the mobile/types.ts " +
    "banner comment for the sync convention. Do not add new knownDrift entries " +
    "to make a new mismatch pass.",
);
process.exit(1);
