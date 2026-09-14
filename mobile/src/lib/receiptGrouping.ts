export interface ReceiptGroupMember {
  receiptGroupId?: string;
}

export const MAX_RECEIPTS_PER_CAPTURE_BATCH = 8;

const ORDINARY_RECEIPT_GROUP = "single-receipt-session";

export function receiptGroupKey(member: ReceiptGroupMember): string {
  return member.receiptGroupId ?? ORDINARY_RECEIPT_GROUP;
}

export function newReceiptGroupId(): string {
  return `receipt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Gives legacy ungrouped pages a durable local boundary before another receipt is added. */
export function makeReceiptGroupsExplicit<T extends ReceiptGroupMember>(members: T[]): T[] {
  const ordinaryId = newReceiptGroupId();
  return members.map((member) => member.receiptGroupId ? member : { ...member, receiptGroupId: ordinaryId });
}

/** Keeps long-receipt pages together while separating crops from one multi-document photo. */
export function groupReceiptMembers<T extends ReceiptGroupMember>(members: T[]): T[][] {
  const groups = new Map<string, T[]>();
  for (const member of members) {
    const key = receiptGroupKey(member);
    const group = groups.get(key) ?? [];
    group.push(member);
    groups.set(key, group);
  }
  return [...groups.values()];
}

/** Reordering is valid only inside one receipt; crossing a boundary changes its financial meaning. */
export function canMoveWithinReceipt<T extends ReceiptGroupMember>(members: T[], index: number, delta: number): boolean {
  const target = index + delta;
  return index >= 0 && target >= 0 && index < members.length && target < members.length
    && receiptGroupKey(members[index]!) === receiptGroupKey(members[target]!);
}
