import { z } from "zod";

/**
 * THE ONE DEFINITION OF "A PESO AMOUNT THIS API WILL ACCEPT".
 *
 * Every money field used to be a bare `z.number().positive()`, which is true
 * of 0.001 — so a sub-centavo amount passed validation, was handed to
 * Prisma.Decimal, and landed in a `Decimal(12,2)` column ROUNDED TO 0.00. The
 * request answered 201 and the books gained a zero-value record: invisible to
 * the owner, but counted by duplicate detection, dashboard sums and the
 * anomaly detectors. `.positive()` had promised exactly the thing that did not
 * happen.
 *
 * So the schema now says what the column says. Two decimal places, because
 * that is the scale of the column and of the currency; an upper bound of ten
 * integer digits, because that is the precision of the column and anything
 * larger is a numeric-overflow 500 rather than a stored amount.
 *
 * Bound and scale are derived from `Decimal(12, 2)` on
 * ExpenseRecord.amount / SalesReferenceRecord.amount / ReceiptScanItem.amount
 * in prisma/schema.prisma. If that column ever changes, change it here in the
 * same commit.
 */
const MONEY_PRECISION = 12;
const MONEY_SCALE = 2;

/** 9_999_999_999.99 — the largest value a Decimal(12, 2) column can hold. */
export const MAX_MONEY_AMOUNT = Number(
  `${"9".repeat(MONEY_PRECISION - MONEY_SCALE)}.${"9".repeat(MONEY_SCALE)}`,
);

/**
 * How many digits this number actually carries after the point.
 *
 * Read off the number's own decimal representation rather than computed with
 * `value * 100`, which is not exact: `1234.56 * 100` is 123455.99999999999,
 * and a tolerance loose enough to forgive that is also loose enough to forgive
 * a genuine third decimal on a large amount.
 *
 * Exponential notation only appears here for magnitudes below 1e-6, which are
 * sub-centavo by definition and must be rejected — hence Infinity.
 */
function decimalPlacesOf(value: number): number {
  const text = value.toString();
  if (text.includes("e") || text.includes("E")) return Infinity;
  const point = text.indexOf(".");
  return point === -1 ? 0 : text.length - point - 1;
}

/**
 * The messages are written for the owner, not for us: this is a 400 the
 * clients surface verbatim next to the amount field.
 */
export const moneyAmountSchema = z
  .number({ invalid_type_error: "Amount must be a number" })
  .finite({ message: "Amount must be a number" })
  .positive({ message: "Amount must be greater than zero" })
  .max(MAX_MONEY_AMOUNT, { message: `Amount must be ${MAX_MONEY_AMOUNT.toLocaleString("en-PH")} or less` })
  .refine((value) => decimalPlacesOf(value) <= MONEY_SCALE, {
    message: "Amount can have at most 2 decimal places (centavos)",
  });
