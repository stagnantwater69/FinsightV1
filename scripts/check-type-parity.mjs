#!/usr/bin/env node
// Compare hand-copied API data contracts, including imported and inherited fields.
import { fileURLToPath } from "node:url";
import path from "node:path";
import { inspectContracts, shapeDifferences } from "./type-parity.mjs";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export const GROUPS = [
  {
    name: "shared API types",
    web: ["web/src/lib/types.ts"],
    mobile: ["mobile/src/lib/types.ts"],
    exempt: {
      // Only mobile calls the cashflow endpoint.
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
      // Mobile keeps duplicate-review types in a separate module.
      "mobile/src/screens/records/scanReceipt/duplicateReview.ts",
    ],
    shapeExempt: {
      ReceiptScanResult: "screen-specific response projections; shared items, batches and history are checked separately",
      ReceiptPageEvidence: "mobile narrows processingMode to its capture modes; web retains server strings",
      ReceiptPageImage: "mobile refines the label through ReceiptPageEvidenceVariant; web retains server strings",
      ReceiptDuplicateCandidate: "mobile validates forward-compatible reason strings; web names the current reason vocabulary",
      ReceiptDuplicateReview: "mobile's parsed review requires a valid non-null fingerprint",
      ReceiptDuplicateCandidatePage: "mobile's parsed page retains validated fingerprint and cursor fields",
    },
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
    shapeExempt: {
      ReceiptProviderTerms: "mobile's parser validates the exact data-class tuple",
      ActiveReceiptProviderConsent: "mobile's parser narrows provider, training policy and data classes",
      ReceiptProviderConsentState: "mobile normalizes defaults and retains only validated active consent",
      ReceiptProviderConsentGrant: "mobile constructs an exact data-class tuple; web uses the offered array",
    },
    exempt: {},
    knownDrift: {},
  },
];

export function checkParity(groups = GROUPS, root = repoRoot, log = console) {
  const paths = (files) => files.map((file) => path.join(root, file));
  const inspector = inspectContracts(groups.flatMap((group) => paths([...group.web, ...group.mobile])));
  let failed = false;
  for (const group of groups) {
    const webTypes = inspector.exportsFrom(paths(group.web));
    const mobileTypes = inspector.exportsFrom(paths(group.mobile));
    const webNames = new Set(webTypes.keys());
    const mobileNames = new Set(mobileTypes.keys());
    const exempt = new Set(Object.keys(group.exempt));
    const drift = group.knownDrift;

    const onlyInWeb = [...webNames].filter((name) => !mobileNames.has(name) && !exempt.has(name));
    const onlyInMobile = [...mobileNames].filter((name) => !webNames.has(name) && !exempt.has(name));
    const matched = [...webNames].filter((name) => mobileNames.has(name)).length;
    const staleDrift = Object.keys(drift).filter((name) => webNames.has(name) && mobileNames.has(name));
    const newInWeb = onlyInWeb.filter((name) => !(name in drift));
    const newInMobile = onlyInMobile.filter((name) => !(name in drift));
    const recordedDrift = [...onlyInWeb, ...onlyInMobile].filter((name) => name in drift);

    log.log(
      `check-type-parity [${group.name}]: ${matched} exported types match on both sides` +
        (recordedDrift.length ? `, ${recordedDrift.length} recorded drift entries still open.` : "."),
    );
    for (const name of recordedDrift) log.log(`  drift: ${name}: ${drift[name]}`);
    if (staleDrift.length) {
      failed = true;
      log.error(`\n[${group.name}] knownDrift entries now present on both sides, remove them from scripts/check-type-parity.mjs:`);
      for (const name of staleDrift) log.error(`  - ${name}`);
    }
    if (newInWeb.length) {
      failed = true;
      log.error(`\n[${group.name}] exported from ${group.web.join(", ")} but missing from ${group.mobile.join(", ")}:`);
      for (const name of newInWeb) log.error(`  - ${name}`);
    }
    if (newInMobile.length) {
      failed = true;
      log.error(`\n[${group.name}] exported from ${group.mobile.join(", ")} but missing from ${group.web.join(", ")}:`);
      for (const name of newInMobile) log.error(`  - ${name}`);
    }
    let compared = 0;
    for (const name of [...webNames].filter((name) => mobileNames.has(name)).sort()) {
      try {
        const differences = shapeDifferences(inspector.shapeOf(webTypes.get(name)), inspector.shapeOf(mobileTypes.get(name)), name);
        if (group.shapeExempt?.[name]) {
          log.log(`  name-only: ${name}: ${group.shapeExempt[name]}`);
          if (!differences.length) {
            failed = true;
            log.error(`  [${group.name}] ${name}: shape exemption is stale; remove it`);
          }
          continue;
        }
        compared += 1;
        if (differences.length) {
          failed = true;
          for (const difference of differences) log.error(`  [${group.name}] ${difference}`);
        }
      } catch (error) {
        failed = true;
        log.error(`  [${group.name}] ${error.message}`);
      }
    }
    log.log(`check-type-parity [${group.name}]: ${compared} data shapes checked.`);
  }
  return !failed;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--help")) {
    console.log("Usage: node scripts/check-type-parity.mjs\nChecks exported API names and recursive TypeScript data shapes. Uses backend's installed TypeScript; no root install.\nSelf-tests: node --test scripts/check-type-parity.test.mjs");
  } else {
    try {
      process.exitCode = checkParity() ? 0 : 1;
    } catch (error) {
      console.error(`check-type-parity: ${error.message}`);
      process.exitCode = 1;
    }
    if (process.exitCode === 1) console.error("\nAlign API fields on both clients. Platform-only exported names require a documented exemption; do not add knownDrift entries to silence mismatches.");
  }
}
