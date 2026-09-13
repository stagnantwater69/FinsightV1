import { Prisma } from "@prisma/client";

export interface ExpenseDuplicateIdentityInput {
  date: Date | string;
  amount: Prisma.Decimal | number;
  vendor?: string | null;
  description?: string | null;
}

export interface NormalizedExpenseDuplicateIdentity {
  date: Date;
  amount: Prisma.Decimal;
  dateKey: string;
  amountCentavos: string;
  vendor: string;
  description: string;
}

export function normalizeExpenseDuplicateText(value: string | null | undefined): string {
  return (value ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function normalizeExpenseDuplicateIdentity(
  input: ExpenseDuplicateIdentityInput,
): NormalizedExpenseDuplicateIdentity | null {
  const parsedDate = input.date instanceof Date ? input.date : new Date(input.date);
  if (!Number.isFinite(parsedDate.getTime())) return null;
  const dateKey = parsedDate.toISOString().slice(0, 10);
  const date = new Date(`${dateKey}T00:00:00.000Z`);
  const amount = new Prisma.Decimal(input.amount);
  return {
    date,
    amount,
    dateKey,
    amountCentavos: amount.mul(100).round().toFixed(0),
    vendor: normalizeExpenseDuplicateText(input.vendor),
    description: normalizeExpenseDuplicateText(input.description),
  };
}

export function sameExpenseDuplicateIdentity(
  left: ExpenseDuplicateIdentityInput,
  right: ExpenseDuplicateIdentityInput,
): boolean {
  const normalizedLeft = normalizeExpenseDuplicateIdentity(left);
  const normalizedRight = normalizeExpenseDuplicateIdentity(right);
  if (!normalizedLeft || !normalizedRight) return false;
  return normalizedLeft.dateKey === normalizedRight.dateKey
    && normalizedLeft.amount.equals(normalizedRight.amount)
    && (
      Boolean(
        normalizedLeft.vendor
        && normalizedRight.vendor
        && normalizedLeft.vendor === normalizedRight.vendor,
      )
      || Boolean(
        normalizedLeft.description
        && normalizedRight.description
        && normalizedLeft.description === normalizedRight.description,
      )
    );
}

export function expenseDuplicateKeysOf(input: ExpenseDuplicateIdentityInput): string[] {
  const identity = normalizeExpenseDuplicateIdentity(input);
  if (!identity) return [];
  const prefix = `${identity.dateKey}|${identity.amountCentavos}`;
  return [
    ...(identity.vendor ? [`${prefix}|vendor:${identity.vendor}`] : []),
    ...(identity.description ? [`${prefix}|description:${identity.description}`] : []),
  ];
}
