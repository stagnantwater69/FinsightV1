import { createHash } from "node:crypto";
import type { ExpenseRecord, ManualRecordKind, Prisma, SalesReferenceRecord } from "@prisma/client";
import { z } from "zod";
import { ApiError } from "../middleware/error.middleware";

export const manualRecordIdempotencyKeySchema = z.string().min(8).max(100).regex(
  /^[A-Za-z0-9_-]+$/,
  "Idempotency key can contain only letters, numbers, underscores and hyphens",
);

export const MANUAL_CREATE_KEY_CONFLICT = "MANUAL_CREATE_KEY_CONFLICT";
export const MANUAL_CREATE_RECORD_DELETED = "MANUAL_CREATE_RECORD_DELETED";

export interface ManualRecordRequestIdentity {
  userId: number;
  businessProfileId: number;
  kind: ManualRecordKind;
  keyHash: string;
  inputHash: string;
}

type ManualRecordReplay =
  | { kind: "EXPENSE"; record: ExpenseRecord }
  | { kind: "SALES"; record: SalesReferenceRecord };

export function manualRecordRequestIdentity(
  userId: number,
  businessProfileId: number,
  kind: ManualRecordKind,
  idempotencyKey: string,
  canonicalInput: readonly unknown[],
): ManualRecordRequestIdentity {
  const key = manualRecordIdempotencyKeySchema.parse(idempotencyKey);
  const hash = (values: readonly unknown[]) => createHash("sha256").update(JSON.stringify(values)).digest("hex");
  return {
    userId,
    businessProfileId,
    kind,
    keyHash: hash(["manual-record-create-key-v1", userId, businessProfileId, kind, key]),
    inputHash: hash(["manual-record-create-input-v1", kind, canonicalInput]),
  };
}

export function manualRecordBaselineInstant(value: string | undefined): string | null {
  if (value === undefined) return null;
  const instant = new Date(value);
  return Number.isFinite(instant.getTime()) ? instant.toISOString() : value;
}

function keyConflict(): never {
  throw new ApiError(409, "This save key was already used with different record details. Review the saved record before trying again.", {
    code: MANUAL_CREATE_KEY_CONFLICT,
  });
}

// Call under the existing profile/kind write gate, before reclassifying an accepted request.
export async function findManualRecordReplay(
  db: Prisma.TransactionClient,
  identity: ManualRecordRequestIdentity,
): Promise<ManualRecordReplay | null> {
  const request = await db.manualRecordCreateRequest.findUnique({
    where: { keyHash: identity.keyHash },
    include: {
      businessProfile: { select: { userId: true } },
      expenseRecord: true,
      salesRecord: true,
    },
  });
  if (!request) return null;
  if (
    request.businessProfileId !== identity.businessProfileId
    || request.businessProfile.userId !== identity.userId
    || request.kind !== identity.kind
    || request.inputHash !== identity.inputHash
  ) keyConflict();

  const record = identity.kind === "EXPENSE" ? request.expenseRecord : request.salesRecord;
  if (!record) {
    throw new ApiError(409, "The record from this save request was deleted. Review your records before starting a new entry.", {
      code: MANUAL_CREATE_RECORD_DELETED,
    });
  }
  if (record.businessProfileId !== identity.businessProfileId) keyConflict();
  return identity.kind === "EXPENSE"
    ? { kind: "EXPENSE", record: request.expenseRecord! }
    : { kind: "SALES", record: request.salesRecord! };
}

export async function persistManualRecordRequest(
  db: Prisma.TransactionClient,
  identity: ManualRecordRequestIdentity,
  recordId: number,
): Promise<void> {
  await db.manualRecordCreateRequest.create({
    data: {
      keyHash: identity.keyHash,
      inputHash: identity.inputHash,
      businessProfileId: identity.businessProfileId,
      kind: identity.kind,
      ...(identity.kind === "EXPENSE"
        ? { expenseRecordId: recordId, expenseRecordBusinessProfileId: identity.businessProfileId }
        : { salesRecordId: recordId, salesRecordBusinessProfileId: identity.businessProfileId }),
    },
  });
}
