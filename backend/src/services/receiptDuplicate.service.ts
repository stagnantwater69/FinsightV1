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

/**
 * Upper bound on the candidate set kept for one source scan.
 *
 * Discovery reads at most this many rows per source table (oldest id first,
 * so a re-run sees the same window) and persistence keeps at most this many
 * targets. Past it, more rows change nothing the owner can decide: the
 * receipt already matches prior records. The pending-key read behind the set
 * hash, the confirm recheck, and `candidateCount` are all bounded by it.
 */
export const RECEIPT_DUPLICATE_CANDIDATE_SET_LIMIT = 200;

/*
 * Cursor contract for the candidate list and the confirm-time first page.
 *
 * Order is candidate row id ascending. A target keeps its row across
 * refreshes and ids are never reused, so the order cannot shift under a
 * client walking pages. The cursor is base64url JSON `{ v: 1, id }` naming
 * the last row served; the next page is every pending row with a greater id.
 * It is a position, not a snapshot: a refresh between pages can supersede or
 * add rows, which the client detects through `candidateSetHash` changing.
 */

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
  // Windows are read oldest-first and capped so the same profile state yields
  // the same set hash, whatever order the planner returns rows in.
  const scanScope = {
    id: { not: sourceReceiptScanId },
    businessProfileId,
    confirmationStatus: "Confirmed" as const,
    purgeJobs: { none: { mode: ReceiptPurgeMode.DELETE_SCAN } },
  };
  const scanSelect = {
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
      orderBy: { id: "asc" as const },
    },
  } satisfies Prisma.ReceiptScanSelect;
  // Exact and same-total matches get their own window so the broad same-date
  // window below can never crowd them out once a profile has more than the
  // cap's worth of confirmed scans on one date.
  const preciseCandidates = await db.receiptScan.findMany({
    where: {
      ...scanScope,
      OR: [
        { semanticFingerprint: identity.fingerprint },
        { extractedDate: identity.date, extractedAmount: identity.amount },
        // Profile scope repeated on purpose: without it the EXISTS subquery
        // has only the date and scans every profile's expenses.
        { expenseRecords: { some: { businessProfileId, date: identity.date, amount: identity.amount } } },
        ...(identity.sourceImageHash ? [{ sourceImageHash: identity.sourceImageHash }] : []),
      ],
    },
    orderBy: { id: "asc" },
    take: RECEIPT_DUPLICATE_CANDIDATE_SET_LIMIT,
    select: scanSelect,
  });
  // Same-date scans whose confirmed splits may sum to the receipt total. This
  // is the only window the cap can truncate.
  const broadCandidates = await db.receiptScan.findMany({
    where: {
      ...scanScope,
      id: { not: sourceReceiptScanId, notIn: preciseCandidates.map((candidate) => candidate.id) },
      expenseRecords: { some: { businessProfileId, date: identity.date } },
    },
    orderBy: { id: "asc" },
    take: RECEIPT_DUPLICATE_CANDIDATE_SET_LIMIT,
    select: scanSelect,
  });
  const scanCandidates = [...preciseCandidates, ...broadCandidates];

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
      orderBy: { id: "asc" },
      take: RECEIPT_DUPLICATE_CANDIDATE_SET_LIMIT,
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

  // Expense targets first, then receipts, oldest first within each: the
  // order rows are created in, and the order that survives the cap.
  return discovered
    .sort((left, right) => {
      const kind = Number(left.candidateReceiptScanId !== null) - Number(right.candidateReceiptScanId !== null);
      if (kind !== 0) return kind;
      return (left.candidateReceiptScanId ?? left.candidateExpenseRecordId!)
        - (right.candidateReceiptScanId ?? right.candidateExpenseRecordId!);
    })
    .slice(0, RECEIPT_DUPLICATE_CANDIDATE_SET_LIMIT);
}

interface CandidateTargetRef {
  candidateReceiptScanId: number | null;
  candidateExpenseRecordId: number | null;
}

function targetKey(candidate: CandidateTargetRef): string {
  return candidate.candidateReceiptScanId === null
    ? `expense:${candidate.candidateExpenseRecordId}`
    : `receipt:${candidate.candidateReceiptScanId}`;
}


/**
 * Holds every discovered target row until this transaction ends and reports
 * which ones still exist. An owner delete does not take the profile gate, so
 * without this the FK check on the insert waits on the delete and fails with
 * P2003 once it commits. KEY SHARE is the lock the FK check takes anyway.
 */
async function lockCandidateTargets(
  db: Prisma.TransactionClient,
  businessProfileId: number,
  targets: CandidateTargetRef[],
): Promise<Set<string>> {
  const expenseIds = targets.flatMap((row) => (row.candidateExpenseRecordId === null ? [] : [row.candidateExpenseRecordId]));
  const scanIds = targets.flatMap((row) => (row.candidateReceiptScanId === null ? [] : [row.candidateReceiptScanId]));
  const surviving = new Set<string>();
  if (expenseIds.length > 0) {
    const rows = await db.$queryRaw<{ id: number }[]>`
      SELECT "ExpenseRecord_ID" AS id
      FROM "ExpenseRecord"
      WHERE "BusinessProfile_ID" = ${businessProfileId}
        AND "ExpenseRecord_ID" IN (${Prisma.join(expenseIds)})
      FOR KEY SHARE
    `;
    for (const row of rows) surviving.add(`expense:${row.id}`);
  }
  if (scanIds.length > 0) {
    const rows = await db.$queryRaw<{ id: number }[]>`
      SELECT "ReceiptScan_ID" AS id
      FROM "ReceiptScan"
      WHERE "BusinessProfile_ID" = ${businessProfileId}
        AND "ReceiptScan_ID" IN (${Prisma.join(scanIds)})
      FOR KEY SHARE
    `;
    for (const row of rows) surviving.add(`receipt:${row.id}`);
  }
  return surviving;
}

async function persistCandidateSet(
  db: Prisma.TransactionClient,
  businessProfileId: number,
  sourceReceiptScanId: number,
  identity: DuplicateIdentity,
  discovered: DiscoveredCandidate[],
): Promise<void> {
  // Every row this detector version wrote for the source, keyed by target.
  // Grows with distinct targets ever matched (each refresh adds at most
  // RECEIPT_DUPLICATE_CANDIDATE_SET_LIMIT), not with the number of refreshes.
  const current = await db.receiptDuplicateCandidate.findMany({
    where: {
      businessProfileId,
      sourceReceiptScanId,
      detectorVersion: RECEIPT_DUPLICATE_DETECTOR_VERSION,
    },
    select: {
      id: true,
      candidateReceiptScanId: true,
      candidateExpenseRecordId: true,
      sourceFingerprint: true,
      reasonCodes: true,
      scoreBand: true,
      reviewStatus: true,
      decisionSetHash: true,
      decidedByUserId: true,
      decidedAt: true,
    },
    orderBy: { id: "asc" },
  });
  const currentByTarget = new Map(current.map((row) => [targetKey(row), row]));
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

  // A row already in the pending state this run would write is left alone, so
  // a re-run of the same identity is read-only. Updates are grouped by the only
  // per-row fields (reason codes, score band), one updateMany per group.
  // A SAVED_ANYWAY row keeps the owner's decision and is never rewritten.
  const updateGroups = new Map<string, Pick<DiscoveredCandidate, "reasonCodes" | "scoreBand"> & { ids: number[] }>();
  const creates: Prisma.ReceiptDuplicateCandidateCreateManyInput[] = [];
  for (const candidate of discovered) {
    const existing = currentByTarget.get(targetKey(candidate));
    const reasons = JSON.stringify(candidate.reasonCodes);
    if (existing) {
      if (existing.reviewStatus === ReceiptDuplicateReviewStatus.SAVED_ANYWAY) continue;
      const unchanged = existing.reviewStatus === ReceiptDuplicateReviewStatus.PENDING
        && existing.sourceFingerprint === identity.fingerprint
        && existing.scoreBand === candidate.scoreBand
        && JSON.stringify(existing.reasonCodes) === reasons
        && existing.decisionSetHash === null
        && existing.decidedByUserId === null
        && existing.decidedAt === null;
      if (unchanged) continue;
      const groupKey = `${candidate.scoreBand}:${reasons}`;
      const group = updateGroups.get(groupKey)
        ?? { reasonCodes: candidate.reasonCodes, scoreBand: candidate.scoreBand, ids: [] };
      group.ids.push(existing.id);
      updateGroups.set(groupKey, group);
      continue;
    }
    creates.push({
      businessProfileId,
      sourceReceiptScanId,
      candidateReceiptScanId: candidate.candidateReceiptScanId,
      candidateExpenseRecordId: candidate.candidateExpenseRecordId,
      detectorVersion: RECEIPT_DUPLICATE_DETECTOR_VERSION,
      sourceFingerprint: identity.fingerprint,
      reasonCodes: candidate.reasonCodes as unknown as Prisma.InputJsonValue,
      scoreBand: candidate.scoreBand,
      reviewStatus: ReceiptDuplicateReviewStatus.PENDING,
    });
  }
  for (const group of updateGroups.values()) {
    await db.receiptDuplicateCandidate.updateMany({
      where: {
        id: { in: group.ids },
        businessProfileId,
        sourceReceiptScanId,
        reviewStatus: { not: ReceiptDuplicateReviewStatus.SAVED_ANYWAY },
      },
      data: {
        sourceFingerprint: identity.fingerprint,
        reasonCodes: group.reasonCodes as unknown as Prisma.InputJsonValue,
        scoreBand: group.scoreBand,
        reviewStatus: ReceiptDuplicateReviewStatus.PENDING,
        decisionSetHash: null,
        decidedByUserId: null,
        decidedAt: null,
      },
    });
  }
  if (creates.length > 0) {
    const refs = creates.map((row) => ({
      candidateReceiptScanId: row.candidateReceiptScanId ?? null,
      candidateExpenseRecordId: row.candidateExpenseRecordId ?? null,
    }));
    const surviving = await lockCandidateTargets(db, businessProfileId, refs);
    const present = creates.filter((_row, index) => surviving.has(targetKey(refs[index]!)));
    if (present.length > 0) {
      await db.receiptDuplicateCandidate.createMany({ data: present });
    }
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

/**
 * Null for a receipt target with nothing left to compare against: a scan
 * confirmed before extracted values were written whose expense records have
 * since been deleted. `visibleCandidateWhere` keeps such rows out of every
 * pending read; this is the in-memory form of the same rule, kept so a row
 * whose target loses its values between the read and this call cannot be
 * served as a candidate with no date or total.
 */
function visibleCandidateValues(candidate: CandidateWithTarget) {
  const scan = candidate.candidateReceiptScan;
  return scan ? confirmedScanValues(scan) : candidate.candidateExpenseRecord;
}

function candidateDTO(candidate: CandidateWithTarget) {
  const scan = candidate.candidateReceiptScan;
  const expense = candidate.candidateExpenseRecord;
  const values = visibleCandidateValues(candidate);
  if (!values) return null;
  return {
    id: candidate.id,
    target: scan
      ? { kind: "receipt" as const, id: scan.id }
      : { kind: "expense" as const, id: expense!.id },
    vendor: values.vendor ?? null,
    date: values.date,
    total: Number(values.amount),
    scoreBand: candidate.scoreBand,
    reasons: reasonCodes(candidate),
  };
}

type CandidateDTO = NonNullable<ReturnType<typeof candidateDTO>>;

function candidateDTOs(candidates: CandidateWithTarget[]): CandidateDTO[] {
  return candidates.map(candidateDTO).filter((dto): dto is CandidateDTO => dto !== null);
}

interface PendingCandidateKey extends CandidateTargetRef {
  id: number;
}

function setHash(sourceFingerprint: string, candidates: CandidateTargetRef[]): string | null {
  if (candidates.length === 0) return null;
  const targets = candidates.map(targetKey).sort();
  return createHash("sha256")
    .update(JSON.stringify({ detector: RECEIPT_DUPLICATE_DETECTOR_VERSION, sourceFingerprint, targets }))
    .digest("hex");
}

/**
 * The database form of `visibleCandidateValues(row) !== null`: a target the
 * owner can be shown. Part of the pending filter so the page, the count, the
 * set hash and the Save-anyway decision all cover exactly the rows served.
 */
const visibleCandidateWhere = {
  OR: [
    // The scalar, not the relation: the target cascades on delete, and the
    // compound-key relation's `isNot: null` matches every row.
    { candidateExpenseRecordId: { not: null } },
    {
      candidateReceiptScan: {
        is: {
          OR: [
            { expenseRecords: { some: {} } },
            { extractedDate: { not: null }, extractedAmount: { not: null } },
          ],
        },
      },
    },
  ],
} satisfies Prisma.ReceiptDuplicateCandidateWhereInput;

const pendingCandidateFilter = (
  businessProfileId: number,
  sourceReceiptScanId: number,
  sourceFingerprint: string,
) => ({
  businessProfileId,
  sourceReceiptScanId,
  sourceFingerprint,
  detectorVersion: RECEIPT_DUPLICATE_DETECTOR_VERSION,
  reviewStatus: ReceiptDuplicateReviewStatus.PENDING,
  ...visibleCandidateWhere,
}) satisfies Prisma.ReceiptDuplicateCandidateWhereInput;

/**
 * The pending set as (id, target) triples: all the set hash, the count, and
 * the Save-anyway decision need. Bounded by the persistence cap rather than a
 * `take` of its own, which would let the hash silently cover a partial set.
 */
async function loadPendingCandidateKeys(
  db: Prisma.TransactionClient | typeof prisma,
  businessProfileId: number,
  sourceReceiptScanId: number,
  sourceFingerprint: string,
): Promise<PendingCandidateKey[]> {
  return db.receiptDuplicateCandidate.findMany({
    where: pendingCandidateFilter(businessProfileId, sourceReceiptScanId, sourceFingerprint),
    select: { id: true, candidateReceiptScanId: true, candidateExpenseRecordId: true },
    orderBy: { id: "asc" },
  });
}

/** One page of pending candidates with their targets, cursor contract as documented above. */
async function loadPendingCandidatePage(
  db: Prisma.TransactionClient | typeof prisma,
  businessProfileId: number,
  sourceReceiptScanId: number,
  sourceFingerprint: string,
  page: { afterId: number | null; take: number },
): Promise<{ candidates: CandidateWithTarget[]; hasMore: boolean }> {
  const rows = await db.receiptDuplicateCandidate.findMany({
    where: {
      ...pendingCandidateFilter(businessProfileId, sourceReceiptScanId, sourceFingerprint),
      ...(page.afterId === null ? {} : { id: { gt: page.afterId } }),
    },
    include: candidateTarget,
    orderBy: { id: "asc" },
    take: page.take + 1,
  });
  return { candidates: rows.slice(0, page.take), hasMore: rows.length > page.take };
}

async function refreshCandidateSet(
  db: Prisma.TransactionClient,
  businessProfileId: number,
  sourceReceiptScanId: number,
  identity: DuplicateIdentity,
  locksHeld = false,
): Promise<PendingCandidateKey[]> {
  if (!locksHeld) {
    await lockDuplicateIdentitySet(db, businessProfileId, sourceReceiptScanId, identity);
  }
  const discovered = await discoverCandidates(db, businessProfileId, sourceReceiptScanId, identity);
  await persistCandidateSet(db, businessProfileId, sourceReceiptScanId, identity, discovered);
  return loadPendingCandidateKeys(db, businessProfileId, sourceReceiptScanId, identity.fingerprint);
}

function cursorId(encoded: string): number {
  try {
    const decoded = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Record<string, unknown>;
    // Postgres int4 bound: a larger id would reach Prisma and surface as a 500.
    if (decoded.v !== 1 || !Number.isInteger(decoded.id) || Number(decoded.id) <= 0 || Number(decoded.id) > 2147483647) {
      throw new Error("shape");
    }
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

  const [keys, page] = await Promise.all([
    loadPendingCandidateKeys(prisma, source.businessProfileId, source.id, source.semanticFingerprint),
    loadPendingCandidatePage(prisma, source.businessProfileId, source.id, source.semanticFingerprint, {
      afterId,
      take: input.take,
    }),
  ]);
  return {
    sourceFingerprint: source.semanticFingerprint,
    candidateSetHash: setHash(source.semanticFingerprint, keys),
    candidates: candidateDTOs(page.candidates),
    candidateCount: keys.length,
    candidatesTruncated: page.hasMore,
    nextCursor: page.hasMore ? encodeCursor(page.candidates.at(-1)!.id) : null,
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
      candidates: CandidateDTO[];
      candidateCount: number;
      candidatesTruncated: boolean;
      nextCursor: string | null;
    };

async function reviewRequired(
  db: Prisma.TransactionClient,
  code: "DUPLICATE_REVIEW_REQUIRED" | "DUPLICATE_REVIEW_CHANGED",
  scope: { businessProfileId: number; sourceReceiptScanId: number; sourceFingerprint: string },
  keys: PendingCandidateKey[],
): Promise<Extract<ReceiptDuplicateGate, { kind: "review-required" }>> {
  const page = await loadPendingCandidatePage(
    db,
    scope.businessProfileId,
    scope.sourceReceiptScanId,
    scope.sourceFingerprint,
    { afterId: null, take: RECEIPT_DUPLICATE_CONFIRM_RESPONSE_LIMIT },
  );
  return {
    kind: "review-required",
    code,
    sourceFingerprint: scope.sourceFingerprint,
    candidateSetHash: setHash(scope.sourceFingerprint, keys)!,
    candidates: candidateDTOs(page.candidates),
    candidateCount: keys.length,
    candidatesTruncated: page.hasMore,
    nextCursor: page.hasMore ? encodeCursor(page.candidates.at(-1)!.id) : null,
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

  const scope = {
    businessProfileId: input.businessProfileId,
    sourceReceiptScanId: input.receiptScanId,
    sourceFingerprint: identity.fingerprint,
  };
  const code = input.decision?.candidateSetHash === candidateSetHash
    ? null
    : input.decision
      ? "DUPLICATE_REVIEW_CHANGED"
      : "DUPLICATE_REVIEW_REQUIRED";
  if (code) {
    return reviewRequired(db, code, scope, candidates);
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
    const current = await loadPendingCandidateKeys(
      db,
      input.businessProfileId,
      input.receiptScanId,
      identity.fingerprint,
    );
    if (current.length === 0) return { kind: "allowed", sourceFingerprint: identity.fingerprint };
    return reviewRequired(db, "DUPLICATE_REVIEW_CHANGED", scope, current);
  }
  return { kind: "allowed", sourceFingerprint: identity.fingerprint };
}
