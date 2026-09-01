export interface ReceiptGroupMember {
  receiptGroupId?: string;
}

/** Keeps long-receipt pages together while separating crops from one multi-document photo. */
export function groupReceiptMembers<T extends ReceiptGroupMember>(members: T[]): T[][] {
  const groups = new Map<string, T[]>();
  const ordinaryKey = "single-receipt-session";
  for (const member of members) {
    const key = member.receiptGroupId ?? ordinaryKey;
    const group = groups.get(key) ?? [];
    group.push(member);
    groups.set(key, group);
  }
  return [...groups.values()];
}
