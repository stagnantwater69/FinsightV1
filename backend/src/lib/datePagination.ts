import { createHash } from "node:crypto";
import { z } from "zod";
import { ApiError } from "../middleware/error.middleware";

export const datePageQuerySchema = z.object({
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().min(1).max(2000).optional(),
});

export interface DatePageInput {
  pageSize?: number;
  cursor?: string;
}

const cursorSchema = z.object({
  v: z.literal(1),
  scope: z.string().length(64),
  id: z.number().int().positive().max(2147483647),
  at: z.string(),
}).strict();

export function dateCursorScope(values: readonly unknown[]): string {
  return createHash("sha256").update(JSON.stringify(values)).digest("hex");
}

export function invalidDateCursor(): never {
  throw new ApiError(400, "Invalid pagination cursor", { code: "INVALID_PAGINATION_CURSOR" });
}

export function decodeDateCursor(encoded: string | undefined, scope: string) {
  if (encoded === undefined) return null;
  try {
    if (encoded.length > 2000 || !/^[A-Za-z0-9_-]+$/.test(encoded)) return invalidDateCursor();
    const cursor = cursorSchema.parse(JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")));
    const at = new Date(cursor.at);
    if (cursor.scope !== scope || !Number.isFinite(at.getTime()) || at.toISOString() !== cursor.at) {
      return invalidDateCursor();
    }
    return { id: cursor.id, at };
  } catch {
    return invalidDateCursor();
  }
}

export function datePageSize(input: DatePageInput): number {
  return datePageQuerySchema.parse(input).pageSize ?? 50;
}

export function finishDatePage<T extends { id: number }>(
  rows: T[],
  pageSize: number,
  scope: string,
  dateOf: (row: T) => Date,
) {
  const items = rows.slice(0, pageSize);
  const last = items.at(-1);
  const nextCursor = rows.length > pageSize && last
    ? Buffer.from(JSON.stringify({ v: 1, scope, id: last.id, at: dateOf(last).toISOString() })).toString("base64url")
    : null;
  return { items, nextCursor };
}
