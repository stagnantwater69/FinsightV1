import {
  buildReceiptQueueReadinessOutput,
  PROVIDER_DISPATCH_RECONCILIATION_AFTER_SECONDS,
  type QueueEvidence,
  type ReceiptQueueReadinessOutput,
} from "./receipt-queue-readiness";

const emptyEvidence: QueueEvidence = {
  receiptQueueDepth: 0,
  activeReceiptLeaseCount: 0,
  claimableReceiptCount: 0,
  oldestClaimableReceiptAgeSeconds: 0,
  failedReceiptCount: 0,
  pendingReceiptPurgeCount: 0,
  staleReceiptPurgeCount: 0,
  exhaustedProviderBudgetCount: 0,
  unsafeProviderBudgetCount: 0,
  providerDispatchCount: 0,
  submittedProviderDispatchCount: 0,
  staleProviderReservationCount: 0,
  staleSubmittedProviderDispatchCount: 0,
  ambiguousProviderDispatchCount: 0,
};

const allowedOutputFields = new Set<keyof ReceiptQueueReadinessOutput>([
  "check",
  "status",
  "database",
  "databaseTransaction",
  "migrations",
  "pendingMigrationCount",
  "failedMigrationCount",
  "workerQueue",
  "receiptQueueDepth",
  "activeReceiptLeaseCount",
  "claimableReceiptCount",
  "oldestClaimableReceiptAgeSeconds",
  "queueStaleAfterSeconds",
  "failedReceiptCount",
  "pendingReceiptPurgeCount",
  "staleReceiptPurgeCount",
  "providerBudget",
  "providerDispatchReview",
  "providerDispatchReconciliationAfterSeconds",
  "exhaustedProviderBudgetCount",
  "unsafeProviderBudgetCount",
  "providerDispatchCount",
  "submittedProviderDispatchCount",
  "staleProviderReservationCount",
  "staleSubmittedProviderDispatchCount",
  "ambiguousProviderDispatchCount",
]);

export function runReceiptQueueReadinessSmoke(): void {
  const normal = buildReceiptQueueReadinessOutput(emptyEvidence, 300);
  const staleSubmitted = buildReceiptQueueReadinessOutput({
    ...emptyEvidence,
    providerDispatchCount: 1,
    submittedProviderDispatchCount: 1,
    staleSubmittedProviderDispatchCount: 1,
  }, 300);

  if (normal.status !== "ok") throw new Error("BASELINE_STATUS_INVALID");
  if (staleSubmitted.status !== "attention") throw new Error("STALE_SUBMITTED_STATUS_INVALID");
  if (staleSubmitted.providerDispatchReview !== "attention") {
    throw new Error("STALE_SUBMITTED_REVIEW_INVALID");
  }
  if (
    staleSubmitted.providerDispatchReconciliationAfterSeconds !==
    PROVIDER_DISPATCH_RECONCILIATION_AFTER_SECONDS
  ) {
    throw new Error("RECONCILIATION_THRESHOLD_INVALID");
  }
  if (Object.keys(staleSubmitted).some((field) => !allowedOutputFields.has(
    field as keyof ReceiptQueueReadinessOutput,
  ))) {
    throw new Error("UNSAFE_OUTPUT_FIELD");
  }
  const normalizedOutput = JSON.stringify(staleSubmitted).toLowerCase();
  const forbiddenFields = [
    "receipttext",
    "objectpath",
    "profileid",
    "scanid",
    "dispatchid",
    "filename",
    "merchant",
  ];
  if (forbiddenFields.some((field) => normalizedOutput.includes(field))) {
    throw new Error("UNSAFE_OUTPUT_CONTENT");
  }

  console.log(JSON.stringify({
    check: "receipt-queue-readiness-smoke",
    status: "ok",
    scenarioCount: 2,
    staleSubmittedReadiness: staleSubmitted.status,
    sensitiveFieldCount: 0,
  }));
}

if (require.main === module) {
  try {
    runReceiptQueueReadinessSmoke();
  } catch {
    console.error(JSON.stringify({
      check: "receipt-queue-readiness-smoke",
      status: "failed",
      errorCode: "QUEUE_READINESS_SCENARIO_FAILED",
    }));
    process.exitCode = 1;
  }
}
