import {
  groupReceiptMembers,
  MAX_RECEIPTS_PER_CAPTURE_BATCH,
  newReceiptGroupId,
  receiptGroupKey,
} from "../../../lib/receiptGrouping";
import type { CapturedPage } from "./types";

export type ReceiptCameraIntent =
  | { kind: "replace-all" }
  | { kind: "replace-group"; groupKey: string; groupId: string }
  | { kind: "append-receipt"; groupId: string };

export const RECEIPT_BATCH_LIMIT_MESSAGE =
  `A batch can contain up to ${MAX_RECEIPTS_PER_CAPTURE_BATCH} receipts. Remove one receipt before continuing.`;

export interface ReceiptCameraHandoff {
  pages: CapturedPage[];
  acceptedPages: CapturedPage[];
  replacedPages: CapturedPage[];
}

export function assertReceiptBatchLimit(pages: readonly CapturedPage[]): CapturedPage[][] {
  const groups = groupReceiptMembers([...pages]);
  if (groups.length > MAX_RECEIPTS_PER_CAPTURE_BATCH) {
    throw new Error(RECEIPT_BATCH_LIMIT_MESSAGE);
  }
  return groups;
}

export function maxReceiptsForCamera(
  pages: readonly CapturedPage[],
  intent: ReceiptCameraIntent,
): number {
  if (intent.kind === "replace-all") return MAX_RECEIPTS_PER_CAPTURE_BATCH;
  const existingCount = groupReceiptMembers([...pages]).length;
  const retainedCount = intent.kind === "replace-group"
    ? Math.max(0, existingCount - 1)
    : existingCount;
  return Math.max(1, MAX_RECEIPTS_PER_CAPTURE_BATCH - retainedCount);
}

function unusedGroupId(used: Set<string>): string {
  let candidate = newReceiptGroupId();
  while (used.has(candidate)) candidate = newReceiptGroupId();
  return candidate;
}

function normalizedGroupId(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function applyReceiptCameraHandoff(
  current: readonly CapturedPage[],
  captured: readonly CapturedPage[],
  intent: ReceiptCameraIntent,
): ReceiptCameraHandoff {
  if (captured.length === 0) {
    return { pages: [...current], acceptedPages: [], replacedPages: [] };
  }

  const capturedGroups = groupReceiptMembers([...captured]);
  if (capturedGroups.length > maxReceiptsForCamera(current, intent)) {
    throw new Error(RECEIPT_BATCH_LIMIT_MESSAGE);
  }

  const replacedPages = intent.kind === "replace-all"
    ? [...current]
    : intent.kind === "replace-group"
      ? current.filter((page) => receiptGroupKey(page) === intent.groupKey)
      : [];
  if (intent.kind === "replace-group" && replacedPages.length === 0) {
    throw new Error("That receipt is no longer in this batch. Close the camera and try again.");
  }

  const retainedPages = intent.kind === "replace-all"
    ? []
    : current.filter((page) => intent.kind !== "replace-group" || receiptGroupKey(page) !== intent.groupKey);
  const usedGroupIds = new Set(retainedPages.map(receiptGroupKey));
  const acceptedPages = capturedGroups.flatMap((group, index) => {
    const reservedId = index === 0 && intent.kind !== "replace-all"
      ? normalizedGroupId(intent.groupId)
      : null;
    const capturedId = normalizedGroupId(group[0]?.receiptGroupId);
    const preferredId = reservedId ?? capturedId;
    const groupId = preferredId && !usedGroupIds.has(preferredId)
      ? preferredId
      : unusedGroupId(usedGroupIds);
    usedGroupIds.add(groupId);
    return group.map((page) => ({ ...page, receiptGroupId: groupId }));
  });

  let pages: CapturedPage[];
  if (intent.kind === "replace-all") {
    pages = acceptedPages;
  } else if (intent.kind === "append-receipt") {
    pages = [...current, ...acceptedPages];
  } else {
    pages = [];
    let inserted = false;
    for (const page of current) {
      if (receiptGroupKey(page) === intent.groupKey) {
        if (!inserted) pages.push(...acceptedPages);
        inserted = true;
      } else {
        pages.push(page);
      }
    }
  }

  // Validate the complete result before the caller commits state or releases files.
  assertReceiptBatchLimit(pages);
  return { pages, acceptedPages, replacedPages };
}
