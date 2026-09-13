import { createHash } from "node:crypto";
import {
  Prisma,
  ReceiptDuplicateReviewStatus,
  ReceiptDuplicateScoreBand,
  ReceiptPurgeMode,
} from "@prisma/client";
import { prisma } from "../config/prisma";
import {
  normalizeExpenseDuplicateIdentity,
  sameExpenseDuplicateIdentity,
} from "../lib/expenseDuplicateIdentity";
import { lockDuplicateKey, lockExpenseDuplicateWriteGate } from "../lib/recordLock";
import { ApiError } from "../middleware/error.middleware";

export const RECEIPT_DUPLICATE_DETECTOR_VERSION = "receipt-semantic-v2";
export const RECEIPT_DUPLICATE_CONFIRM_RESPONSE_LIMIT = 20;

export const RECEIPT_DUPLICATE_REASON_CODES = [
  "EXACT_IMAGE",
  "SAME_VENDOR",
  "SAME_DESCRIPTION",
  "SAME_DATE",
  "SAME_TOTAL",
] as const;

export type ReceiptDuplicateReasonCode = (typeof RECEIPT_DUPLICATE_REASON_CODES)[number];

export interface ReceiptDuplicateDecision {
  action: "SAVE_ANYWAY";
  candidateSetHash: string;
}

interface DuplicateIdentityInput {
  date: Date | string | null;
  vendor?: string | null;
  description?: string | null;
  amount: Prisma.Decimal | number | null;
  sourceImageHash?: string | null;
}

interface DuplicateIdentity {
  date: Date;
  amount: Prisma.Decimal;
  vendor: string;
  description: string;
  fingerprint: string;
  sourceImageHash: string | null;
}

interface DiscoveredCandidate {
  candidateReceiptScanId: number | null;
  candidateExpenseRecordId: number | null;
  reasonCodes: ReceiptDuplicateReasonCode[];
  scoreBand: ReceiptDuplicateScoreBand;
}

const candidateTarget = {
  candidateReceiptScan: {
    select: {
      id: true,
      extractedVendor: true,
      extractedDate: true,
      extractedDescription: true,
      extractedAmount: true,
      expenseRecords: {
        select: {
          date: true,
          vendor: true,
          description: true,
          amount: true,
        },
        orderBy: { id: "asc" as const },
      },
    },
  },
  candidateExpenseRecord: {
    select: {
      id: true,
      vendor: true,
      date: true,
      amount: true,
    },
  },
} satisfies Prisma.ReceiptDuplicateCandidateInclude;

type CandidateWithTarget = Prisma.ReceiptDuplicateCandidateGetPayload<{
  include: typeof candidateTarget;
}>;

function identityFor(input: DuplicateIdentityInput): DuplicateIdentity | null {
  if (input.date === null || input.amount === null) return null;
  const normalized = normalizeExpenseDuplicateIdentity({
    date: input.date,
    amount: input.amount,
    vendor: input.vendor,
    description: input.description,
  });
  if (!normalized) return null;
  const { date, amount, vendor, description, amountCentavos } = normalized;
  if (!vendor && !description && !input.sourceImageHash) return null;
  const canonical = JSON.stringify({
    version: 1,
    date: date.toISOString().slice(0, 10),
    amountCentavos,
    vendor,
    description,
  });
  return {
    date,
    amount,
    vendor,
    description,
    fingerprint: createHash("sha256").update(canonical).digest("hex"),
    sourceImageHash: input.sourceImageHash ?? null,
  };
}

function sameSemanticIdentity(
  identity: DuplicateIdentity,
  candidate: { date: Date; amount: Prisma.Decimal; vendor: string | null; description: string | null },
): boolean {
  return sameExpenseDuplicateIdentity(identity, candidate);
}

function semanticReasons(
  identity: DuplicateIdentity,
  candidate: { date: Date; amount: Prisma.Decimal; vendor: string | null; description: string | null },
): ReceiptDuplicateReasonCode[] {
  const normalized = normalizeExpenseDuplicateIdentity(candidate);
  if (!normalized) return [];
  return [
    ...(identity.vendor && normalized.vendor === identity.vendor
      ? (["SAME_VENDOR"] as const)
      : []),
    ...(identity.description && normalized.description === identity.description
      ? (["SAME_DESCRIPTION"] as const)
      : []),
    ...(candidate.date.getTime() === identity.date.getTime() ? (["SAME_DATE"] as const) : []),
    ...(candidate.amount.equals(identity.amount) ? (["SAME_TOTAL"] as const) : []),
  ];
}

function duplicateIdentityLockKeys(sourceReceiptScanId: number, identity: DuplicateIdentity): string[] {
  const semanticPrefix = JSON.stringify({
    date: identity.date.toISOString().slice(0, 10),
    amountCentavos: identity.amount.mul(100).round().toFixed(0),
  });
  const keys = [
    `receipt-source:${sourceReceiptScanId}`,
    ...(identity.sourceImageHash ? [`receipt-image:${identity.sourceImageHash}`] : []),
    ...(identity.vendor
      ? [`receipt-vendor:${createHash("sha256").update(`${semanticPrefix}\0${identity.vendor}`).digest("hex")}`]
      : []),
    ...(identity.description
      ? [`receipt-description:${createHash("sha256").update(`${semanticPrefix}\0${identity.description}`).digest("hex")}`]
      : []),
  ];
  return [...new Set(keys)].sort();
}

async function lockDuplicateIdentitySet(
  db: Prisma.TransactionClient,
  businessProfileId: number,
  sourceReceiptScanId: number,
  identity: DuplicateIdentity,
): Promise<void> {
  await lockExpenseDuplicateWriteGate(db, businessProfileId);
  for (const key of duplicateIdentityLockKeys(sourceReceiptScanId, identity)) {
    await lockDuplicateKey(db, businessProfileId, key);
  }
}

function confirmedScanValues(candidate: {
  extractedDate: Date | null;
  extractedVendor: string | null;
  extractedDescription: string | null;
  extractedAmount: Prisma.Decimal | null;
  expenseRecords: {
    date: Date;
    vendor: string | null;
    description: string;
    amount: Prisma.Decimal;
  }[];
}) {
  if (candidate.expenseRecords.length === 0) {
    return candidate.extractedDate && candidate.extractedAmount
      ? {
          date: candidate.extractedDate,
          vendor: candidate.extractedVendor,
          description: candidate.extractedDescription,
          amount: candidate.extractedAmount,
        }
      : null;
  }

  const [first] = candidate.expenseRecords;
  return {
    date: first!.date,
    vendor: candidate.expenseRecords.find((record) => record.vendor)?.vendor ?? null,
    description: candidate.extractedDescription
      ?? (candidate.expenseRecords.length === 1 ? first!.description : null),
    amount: candidate.expenseRecords.reduce(
      (total, record) => total.add(record.amount),
      new Prisma.Decimal(0),
    ),
  };
}

async function discoverCandidates(
  db: Prisma.TransactionClient,
  businessProfileId: number,
  sourceReceiptScanId: number,
  identity: DuplicateIdentity,
): Promise<DiscoveredCandidate[]> {
  const scanCandidates = await db.receiptScan.findMany({
    where: {
      id: { not: sourceReceiptScanId },
      businessProfileId,
      confirmationStatus: "Confirmed",
      purgeJobs: { none: { mode: ReceiptPurgeMode.DELETE_SCAN } },
      OR: [
        { semanticFingerprint: identity.fingerprint },
        { extractedDate: identity.date, extractedAmount: identity.amount },
        { expenseRecords: { some: { date: identity.date } } },
        ...(identity.sourceImageHash ? [{ sourceImageHash: identity.sourceImageHash }] : []),
      ],
    },
    select: {
      id: true,
      sourceImageHash: true,
      semanticFingerprint: true,
      extractedDate: true,
      extractedVendor: true,
      extractedDescription: true,
      extractedAmount: true,
      expenseRecords: {
        select: {
          date: true,
          vendor: true,
          description: true,
          amount: true,
        },
        orderBy: { id: "asc" },
      },
    },
  });

  const discovered: DiscoveredCandidate[] = [];
  for (const candidate of scanCandidates) {
    const exactImage = Boolean(
      identity.sourceImageHash
      && candidate.sourceImageHash === identity.sourceImageHash,
    );
    const confirmedValues = confirmedScanValues(candidate);
    const semantic = candidate.semanticFingerprint === identity.fingerprint || (
      confirmedValues !== null
      && sameSemanticIdentity(identity, confirmedValues)
    );
    if (!exactImage && !semantic) continue;
    const reasons = [
      ...(exactImage ? (["EXACT_IMAGE"] as const) : []),
      ...(confirmedValues ? semanticReasons(identity, confirmedValues) : []),
    ];
    discovered.push({
      candidateReceiptScanId: candidate.id,
      candidateExpenseRecordId: null,
      reasonCodes: reasons,
      scoreBand: exactImage || reasons.includes("SAME_VENDOR")
        ? ReceiptDuplicateScoreBand.EXACT
        : ReceiptDuplicateScoreBand.LIKELY,
    });
  }

  if (identity.vendor || identity.description) {
    const expenseCandidates = await db.expenseRecord.findMany({
      where: {
        businessProfileId,
        receiptScanId: null,
        date: identity.date,
        amount: identity.amount,
      },
      select: { id: true, date: true, amount: true, vendor: true, description: true },
    });
    for (const candidate of expenseCandidates) {
      if (!sameSemanticIdentity(identity, candidate)) continue;
      const reasons = semanticReasons(identity, candidate);
      discovered.push({
        candidateReceiptScanId: null,
        candidateExpenseRecordId: candidate.id,
        reasonCodes: reasons,
        scoreBand: reasons.includes("SAME_VENDOR")
          ? ReceiptDuplicateScoreBand.EXACT
          : ReceiptDuplicateScoreBand.LIKELY,
      });
    }
  }

  return discovered.sort((left, right) => {
    const leftKey = left.candidateReceiptScanId === null
      ? `expense:${left.candidateExpenseRecordId}`
      : `receipt:${left.candidateReceiptScanId}`;
    const rightKey = right.candidateReceiptScanId === null
      ? `expense:${right.candidateExpenseRecordId}`
      : `receipt:${right.candidateReceiptScanId}`;
    return leftKey.localeCompare(rightKey);
  });
}

function targetKey(candidate: {
  candidateReceiptScanId: number | null;
  candidateExpenseRecordId: number | null;
}): string {
  return candidate.candidateReceiptScanId === null
    ? `expense:${candidate.candidateExpenseRecordId}`
    : `receipt:${candidate.candidateReceiptScanId}`;
}

async function persistCandidateSet(
  db: Prisma.TransactionClient,
  businessProfileId: number,
  sourceReceiptScanId: number,
  identity: DuplicateIdentity,
  discovered: DiscoveredCandidate[],
): Promise<void> {
  const current = await db.receiptDuplicateCandidate.findMany({
    where: {
      businessProfileId,
      sourceReceiptScanId,
      detectorVersion: RECEIPT_DUPLICATE_DETECTOR_VERSION,
    },
  });
  const discoveredKeys = new Set(discovered.map(targetKey));
  const staleIds = current
    .filter((candidate) =>
      candidate.reviewStatus === ReceiptDuplicateReviewStatus.PENDING
      && !discoveredKeys.has(targetKey(candidate)),
    )
    .map((candidate) => candidate.id);
  if (staleIds.length > 0) {
    await db.receiptDuplicateCandidate.updateMany({
      where: { id: { in: staleIds }, businessProfileId, sourceReceiptScanId },
      data: { reviewStatus: ReceiptDuplicateReviewStatus.SUPERSEDED },
    });
  }

  for (const candidate of discovered) {
    const existing = current.find((row) => targetKey(row) === targetKey(candidate));
    const data = {
      sourceFingerprint: identity.fingerprint,
      reasonCodes: candidate.reasonCodes as unknown as Prisma.InputJsonValue,
      scoreBand: candidate.scoreBand,
      reviewStatus: ReceiptDuplicateReviewStatus.PENDING,
      decisionSetHash: null,
      decidedByUserId: null,
      decidedAt: null,
    };
    if (existing) {
      if (existing.reviewStatus !== ReceiptDuplicateReviewStatus.SAVED_ANYWAY) {
        await db.receiptDuplicateCandidate.update({ where: { id: existing.id }, data });
      }
      continue;
    }
    await db.receiptDuplicateCandidate.create({
      data: {
        businessProfileId,
        sourceReceiptScanId,
        candidateReceiptScanId: candidate.candidateReceiptScanId,
        candidateExpenseRecordId: candidate.candidateExpenseRecordId,
        detectorVersion: RECEIPT_DUPLICATE_DETECTOR_VERSION,
        ...data,
      },
    });
  }

  const sourceUpdated = await db.receiptScan.updateMany({
    where: {
      id: sourceReceiptScanId,
      businessProfileId,
      confirmationStatus: "Pending",
      processingStatus: "Complete",
      evidenceDeletionRequestedAt: null,
      purgeJobs: { none: { mode: ReceiptPurgeMode.DELETE_SCAN } },
    },
    data: { semanticFingerprint: identity.fingerprint },
  });
  if (sourceUpdated.count !== 1) {
    throw new ApiError(409, "This receipt changed while duplicate candidates were being checked");
  }
}

function reasonCodes(candidate: CandidateWithTarget): ReceiptDuplicateReasonCode[] {
  if (!Array.isArray(candidate.reasonCodes)) return [];
  const allowed = new Set<string>(RECEIPT_DUPLICATE_REASON_CODES);
  return candidate.reasonCodes.filter(
    (value): value is ReceiptDuplicateReasonCode => typeof value === "string" && allowed.has(value),
  );
}

function candidateDTO(candidate: CandidateWithTarget) {
  const scan = candidate.candidateReceiptScan;
  const expense = candidate.candidateExpenseRecord;
  const confirmed = scan ? confirmedScanValues(scan) : null;
  return {
    id: candidate.id,
    target: scan
      ? { kind: "receipt" as const, id: scan.id }
      : { kind: "expense" as const, id: expense!.id },
    vendor: confirmed?.vendor ?? expense?.vendor ?? null,
    date: confirmed?.date ?? expense!.date,
    total: Number(confirmed?.amount ?? expense!.amount),
    scoreBand: candidate.scoreBand,
    reasons: reasonCodes(candidate),
  };
}

function setHash(sourceFingerprint: string, candidates: CandidateWithTarget[]): string | null {
  if (candidates.length === 0) return null;
  const targets = candidates.map(targetKey).sort();
  return createHash("sha256")
    .update(JSON.stringify({ detector: RECEIPT_DUPLICATE_DETECTOR_VERSION, sourceFingerprint, targets }))
    .digest("hex");
}

async function loadPendingCandidates(
  db: Prisma.TransactionClient | typeof prisma,
  businessProfileId: number,
  sourceReceiptScanId: number,
  sourceFingerprint: string,
): Promise<CandidateWithTarget[]> {
  return db.receiptDuplicateCandidate.findMany({
    where: {
      businessProfileId,
      sourceReceiptScanId,
      sourceFingerprint,
      detectorVersion: RECEIPT_DUPLICATE_DETECTOR_VERSION,
      reviewStatus: ReceiptDuplicateReviewStatus.PENDING,
    },
    include: candidateTarget,
    orderBy: { id: "asc" },
  });
}

async function refreshCandidateSet(
  db: Prisma.TransactionClient,
  businessProfileId: number,
  sourceReceiptScanId: number,
  identity: DuplicateIdentity,
  locksHeld = false,
): Promise<CandidateWithTarget[]> {
  if (!locksHeld) {
    await lockDuplicateIdentitySet(db, businessProfileId, sourceReceiptScanId, identity);
  }
  const discovered = await discoverCandidates(db, businessProfileId, sourceReceiptScanId, identity);
  await persistCandidateSet(db, businessProfileId, sourceReceiptScanId, identity, discovered);
  return loadPendingCandidates(db, businessProfileId, sourceReceiptScanId, identity.fingerprint);
}

function cursorId(encoded: string): number {
  try {
    const decoded = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Record<string, unknown>;
    if (decoded.v !== 1 || !Number.isInteger(decoded.id) || Number(decoded.id) <= 0) throw new Error("shape");
    return Number(decoded.id);
  } catch {
    throw new ApiError(400, "Invalid duplicate-candidate cursor");
  }
}

function encodeCursor(id: number): string {
  return Buffer.from(JSON.stringify({ v: 1, id })).toString("base64url");
}

export async function listReceiptDuplicateCandidates(
  userId: number,
  receiptScanId: number,
  input: { cursor?: string; take: number },
) {
  const afterId = input.cursor ? cursorId(input.cursor) : null;
  const source = await prisma.receiptScan.findFirst({
    where: {
      id: receiptScanId,
      businessProfile: { userId },
      confirmationStatus: "Pending",
      processingStatus: "Complete",
      evidenceDeletionRequestedAt: null,
      purgeJobs: { none: { mode: ReceiptPurgeMode.DELETE_SCAN } },
    },
    select: {
      id: true,
      businessProfileId: true,
      semanticFingerprint: true,
    },
  });
  if (!source?.businessProfileId) throw new ApiError(404, "Receipt scan not found");
  if (!source.semanticFingerprint) {
    return {
      sourceFingerprint: null,
      candidateSetHash: null,
      candidates: [],
      candidateCount: 0,
      candidatesTruncated: false,
      nextCursor: null,
    };
  }

  const all = await loadPendingCandidates(
    prisma,
    source.businessProfileId,
    source.id,
    source.semanticFingerprint,
  );
  const visible = all.filter((candidate) => afterId === null || candidate.id > afterId);
  const page = visible.slice(0, input.take);
  const hasMore = visible.length > page.length;
  return {
    sourceFingerprint: source.semanticFingerprint,
    candidateSetHash: setHash(source.semanticFingerprint, all),
    candidates: page.map(candidateDTO),
    candidateCount: all.length,
    candidatesTruncated: hasMore,
    nextCursor: hasMore ? encodeCursor(page.at(-1)!.id) : null,
  };
}

export async function refreshReceiptDuplicateCandidatesForScan(
  db: Prisma.TransactionClient,
  receiptScanId: number,
  businessProfileId: number,
): Promise<void> {
  const scan = await db.receiptScan.findFirst({
    where: { id: receiptScanId, businessProfileId },
    select: {
      extractedDate: true,
      extractedVendor: true,
      extractedDescription: true,
      extractedAmount: true,
      sourceImageHash: true,
    },
  });
  if (!scan) return;
  const identity = identityFor({
    date: scan.extractedDate,
    vendor: scan.extractedVendor,
    description: scan.extractedDescription,
    amount: scan.extractedAmount,
    sourceImageHash: scan.sourceImageHash,
  });
  if (!identity) return;
  await refreshCandidateSet(db, businessProfileId, receiptScanId, identity);
}

export type ReceiptDuplicateGate =
  | { kind: "allowed"; sourceFingerprint: string }
  | {
      kind: "review-required";
      code: "DUPLICATE_REVIEW_REQUIRED" | "DUPLICATE_REVIEW_CHANGED";
      sourceFingerprint: string;
      candidateSetHash: string;
      candidates: ReturnType<typeof candidateDTO>[];
      candidateCount: number;
      candidatesTruncated: boolean;
      nextCursor: string | null;
    };

function reviewRequired(
  code: "DUPLICATE_REVIEW_REQUIRED" | "DUPLICATE_REVIEW_CHANGED",
  sourceFingerprint: string,
  candidates: CandidateWithTarget[],
): Extract<ReceiptDuplicateGate, { kind: "review-required" }> {
  const visible = candidates.slice(0, RECEIPT_DUPLICATE_CONFIRM_RESPONSE_LIMIT);
  return {
    kind: "review-required",
    code,
    sourceFingerprint,
    candidateSetHash: setHash(sourceFingerprint, candidates)!,
    candidates: visible.map(candidateDTO),
    candidateCount: candidates.length,
    candidatesTruncated: candidates.length > visible.length,
    nextCursor: candidates.length > visible.length ? encodeCursor(visible.at(-1)!.id) : null,
  };
}

export async function evaluateReceiptDuplicateGate(
  db: Prisma.TransactionClient,
  input: {
    userId: number;
    businessProfileId: number;
    receiptScanId: number;
    date: string;
    vendor?: string;
    description: string;
    amount: number;
    sourceImageHash: string | null;
    decision?: ReceiptDuplicateDecision;
  },
): Promise<ReceiptDuplicateGate> {
  const identity = identityFor(input);
  if (!identity) throw new ApiError(400, "Receipt date, merchant, description, and total are required");

  await lockDuplicateIdentitySet(
    db,
    input.businessProfileId,
    input.receiptScanId,
    identity,
  );
  const source = await db.receiptScan.findFirst({
    where: {
      id: input.receiptScanId,
      businessProfileId: input.businessProfileId,
      businessProfile: { userId: input.userId },
      evidenceDeletionRequestedAt: null,
      purgeJobs: { none: { mode: ReceiptPurgeMode.DELETE_SCAN } },
    },
    select: { confirmationStatus: true, processingStatus: true },
  });
  if (!source) throw new ApiError(404, "Receipt scan not found");
  if (source.confirmationStatus !== "Pending") {
    throw new ApiError(409, "This receipt scan is already being confirmed");
  }
  if (source.processingStatus !== "Complete") {
    throw new ApiError(409, "This receipt changed while duplicate candidates were being checked");
  }
  const candidates = await refreshCandidateSet(
    db,
    input.businessProfileId,
    input.receiptScanId,
    identity,
    true,
  );
  const candidateSetHash = setHash(identity.fingerprint, candidates);
  if (!candidateSetHash) return { kind: "allowed", sourceFingerprint: identity.fingerprint };

  const code = input.decision?.candidateSetHash === candidateSetHash
    ? null
    : input.decision
      ? "DUPLICATE_REVIEW_CHANGED"
      : "DUPLICATE_REVIEW_REQUIRED";
  if (code) {
    return reviewRequired(code, identity.fingerprint, candidates);
  }

  const decidedAt = new Date();
  const decided = await db.receiptDuplicateCandidate.updateMany({
    where: {
      id: { in: candidates.map((candidate) => candidate.id) },
      businessProfileId: input.businessProfileId,
      sourceReceiptScanId: input.receiptScanId,
      reviewStatus: ReceiptDuplicateReviewStatus.PENDING,
    },
    data: {
      reviewStatus: ReceiptDuplicateReviewStatus.SAVED_ANYWAY,
      decisionSetHash: candidateSetHash,
      decidedByUserId: input.userId,
      decidedAt,
    },
  });
  if (decided.count !== candidates.length) {
    const current = await loadPendingCandidates(
      db,
      input.businessProfileId,
      input.receiptScanId,
      identity.fingerprint,
    );
    if (current.length === 0) return { kind: "allowed", sourceFingerprint: identity.fingerprint };
    return reviewRequired("DUPLICATE_REVIEW_CHANGED", identity.fingerprint, current);
  }
  return { kind: "allowed", sourceFingerprint: identity.fingerprint };
}
