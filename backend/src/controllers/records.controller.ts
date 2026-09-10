import type { Request, Response } from "express";
import { z } from "zod";
import * as expenseRecordService from "../services/expenseRecord.service";
import * as salesRecordService from "../services/salesRecord.service";
import {
  DEFAULT_RECORD_SORT,
  RECORD_SORTS,
  recordSortDirection,
  recordSortField,
  type RecordSort,
} from "../lib/recordSort";

const searchQuerySchema = z.object({
  businessProfileId: z.coerce.number().int().positive(),
  type: z.enum(["expense", "sales", "all"]).default("all"),
  categoryId: z.coerce.number().int().positive().optional(),
  dateFrom: z.string().date().optional(),
  dateTo: z.string().date().optional(),
  keyword: z.string().max(255).optional(),
  // Enum keys, not the Title Case display labels — the display labels are
  // what the DB columns store (@map), but the API speaks Prisma enum keys
  // like every other enum field in this app.
  source: z.enum(["MANUAL_ENTRY", "CSV_UPLOAD", "RECEIPT_SCAN"]).optional(),
  // Only meaningful alongside source=CSV_UPLOAD, but not rejected otherwise —
  // a stale query param left over from switching sources should be ignored,
  // not turned into a 400 for the owner.
  importBatchId: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  /**
   * Server-side ordering. Omitting it keeps the order this endpoint has always
   * returned, so clients that do not know about it are unaffected.
   *
   * It exists because the clients were sorting the page they had in hand: on a
   * 21k-row ledger, "amount, highest first" over the 100 most recent records is
   * not the biggest spend, it just looks like it. Sorting has to be a property
   * of the query, not of the rendered page.
   */
  sort: z.enum(RECORD_SORTS).default(DEFAULT_RECORD_SORT),
  cursor: z.string().max(500).optional(),
});

/**
 * The flagged list is PAGINATED NOW, and the default is capped.
 *
 * It used to answer with every flagged record a business had. A re-imported
 * spreadsheet flags every row it re-adds, so a real fixture of ~21k rows
 * imported twice made this an ~8 MB response — refetched on every filter
 * change, by two clients that mostly wanted the NUMBER for a badge. That
 * number now has its own endpoint (`flaggedCount`), and the list is bounded.
 *
 * BACKWARD COMPATIBILITY, deliberately: a request with neither `limit` nor
 * `cursor` still gets a bare JSON array, exactly the shape both clients parse
 * today — only capped at DEFAULT_FLAGGED_LIMIT, with `X-Next-Cursor` set when
 * there is more. A request that asks for either gets the paginated envelope
 * `{ items, nextCursor }`, which is what the clients should move to.
 */
const flaggedQuerySchema = z.object({
  businessProfileId: z.coerce.number().int().positive(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().max(500).optional(),
});

/**
 * What an un-updated client gets. Higher than the paginated `limit` ceiling on
 * purpose: it is a safety cap on an old caller that expects the whole list,
 * not a page size anyone chose.
 */
const DEFAULT_FLAGGED_LIMIT = 200;

const cursorSchema = z.object({
  date: z.string().datetime(),
  /**
   * Decimal string, present on cursors minted under an amount sort. Absent on
   * date-sorted cursors, including every cursor issued before `sort` existed.
   */
  amount: z.string().max(32).optional(),
  type: z.enum(["expense", "sales"]),
  id: z.number().int().positive(),
  /** Older cursors predate the parameter and can only have meant the default. */
  sort: z.enum(RECORD_SORTS).default(DEFAULT_RECORD_SORT),
});

type SearchCursor = z.infer<typeof cursorSchema>;

function invalidCursor(): never {
  throw new z.ZodError([{ code: "custom", path: ["cursor"], message: "Invalid pagination cursor" }]);
}

/**
 * A cursor is only meaningful under the sort it was minted for — its key
 * columns are that sort's key columns. Changing `sort` mid-page would otherwise
 * skip or repeat rows, so a mismatched cursor is rejected and the client starts
 * the new ordering from the first page.
 */
function decodeCursor(value: string | undefined, sort: RecordSort = DEFAULT_RECORD_SORT): SearchCursor | undefined {
  if (!value) return undefined;
  let parsed: SearchCursor;
  try {
    parsed = cursorSchema.parse(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
  } catch {
    invalidCursor();
  }
  if (parsed.sort !== sort) invalidCursor();
  if (recordSortField(sort) === "amount" && parsed.amount === undefined) invalidCursor();
  return parsed;
}

type MergeableRecord = { date: Date; amount: number; type: "expense" | "sales"; id: number };

/**
 * The merge that reproduces, across the two tables, the order each table was
 * queried in. Same keys in the same directions, with `type` breaking a tie on
 * the sort column and `id` breaking a tie on both — which is exactly the key
 * the cursor carries.
 */
function makeComparator(sort: RecordSort) {
  const field = recordSortField(sort);
  const descending = recordSortDirection(sort) === "desc";
  return (a: MergeableRecord, b: MergeableRecord): number => {
    const key = field === "amount" ? a.amount - b.amount : a.date.getTime() - b.date.getTime();
    if (key) return descending ? -key : key;
    const type = (a.type === "expense" ? 0 : 1) - (b.type === "expense" ? 0 : 1);
    if (type) return type;
    return descending ? b.id - a.id : a.id - b.id;
  };
}

const compareRecords = makeComparator(DEFAULT_RECORD_SORT);

function encodeCursor(last: MergeableRecord, sort: RecordSort): string {
  return Buffer.from(
    JSON.stringify({
      date: last.date.toISOString(),
      amount: recordSortField(sort) === "amount" ? last.amount.toFixed(2) : undefined,
      type: last.type,
      id: last.id,
      sort,
    }),
  ).toString("base64url");
}

export async function search(req: Request, res: Response) {
  const query = searchQuerySchema.parse(req.query);
  const userId = req.user!.id;
  const sort = query.sort;
  const cursor = decodeCursor(query.cursor, sort);
  const common = { take: query.limit + 1, sort };
  const cursorFor = (side: "expense" | "sales") =>
    cursor
      ? {
          date: new Date(cursor.date),
          amount: cursor.amount,
          id: cursor.id,
          mode:
            cursor.type === side
              ? ("same-type" as const)
              : // Equal keys are ordered expenses-then-sales, so a sales cursor
                // has already consumed the expenses sharing its key while an
                // expense cursor has not yet reached the sales sharing it.
                side === "expense"
                ? ("exclude-key" as const)
                : ("include-key" as const),
        }
      : undefined;

  const [expenses, sales] = await Promise.all([
    query.type !== "sales"
      ? expenseRecordService.searchExpenseRecords(userId, {
          businessProfileId: query.businessProfileId,
          categoryId: query.categoryId,
          dateFrom: query.dateFrom,
          dateTo: query.dateTo,
          keyword: query.keyword,
          source: query.source,
          importBatchId: query.importBatchId,
          ...common,
          cursor: cursorFor("expense"),
        })
      : Promise.resolve([]),
    // Two filters that no sales record can ever satisfy, so the sales half is
    // skipped rather than run and merged in:
    //  - RECEIPT_SCAN: receipts are expenses only, and the sales source enum
    //    has no such value to query for.
    //  - categoryId: the sales table has no category column at all. Running the
    //    query anyway returned the entire sales ledger alongside the one
    //    category the owner asked for, which is what FUN-010 reported.
    query.type !== "expense" && query.source !== "RECEIPT_SCAN" && query.categoryId === undefined
      ? salesRecordService.searchSalesRecords(userId, {
          businessProfileId: query.businessProfileId,
          dateFrom: query.dateFrom,
          dateTo: query.dateTo,
          keyword: query.keyword,
          source: query.source,
          importBatchId: query.importBatchId,
          ...common,
          cursor: cursorFor("sales"),
        })
      : Promise.resolve([]),
  ]);

  // Each half over-fetched by one, so a merged length past the page size still
  // means "there is more" even when one half was skipped entirely.
  const merged = [...expenses, ...sales].sort(makeComparator(sort));
  const items = merged.slice(0, query.limit);
  const last = items.at(-1);
  const hasMore = merged.length > query.limit;
  const nextCursor = hasMore && last ? encodeCursor(last, sort) : null;
  res.status(200).json({ items, nextCursor });
}

/**
 * A ceiling on one request, not on how many duplicates a business may have.
 *
 * A re-imported spreadsheet is the case this exists for and they run to
 * hundreds of rows, so the limit has to clear a realistic import comfortably.
 * It is here to stop an unbounded `IN (...)` being built from request input at
 * all, which is a different concern from what any real owner would send.
 */
const MAX_BULK_IDS = 1000;

const resolveDuplicatesSchema = z.object({
  businessProfileId: z.coerce.number().int().positive(),
  action: z.enum(["keep", "discard"]),
  expenseIds: z.array(z.number().int().positive()).max(MAX_BULK_IDS).default([]),
  salesIds: z.array(z.number().int().positive()).max(MAX_BULK_IDS).default([]),
});

export async function resolveDuplicates(req: Request, res: Response) {
  const body = resolveDuplicatesSchema.parse(req.body);
  const userId = req.user!.id;

  /*
   * Sequential, not Promise.all. Both halves can delete records that share an
   * import batch, and cleanUpImportBatchIfOrphaned decides whether to remove
   * that batch by counting what is left across BOTH tables — running the two
   * concurrently lets each count rows the other is in the middle of deleting,
   * and the batch survives with nothing pointing at it.
   */
  const expenses = await expenseRecordService.bulkResolveExpenseDuplicates(
    userId,
    body.businessProfileId,
    body.expenseIds,
    body.action,
  );
  const sales = await salesRecordService.bulkResolveSalesDuplicates(
    userId,
    body.businessProfileId,
    body.salesIds,
    body.action,
  );

  res.status(200).json({ action: body.action, resolved: expenses + sales, expenses, sales });
}

export async function flagged(req: Request, res: Response) {
  const query = flaggedQuerySchema.parse(req.query);
  const userId = req.user!.id;
  const paginated = query.limit !== undefined || query.cursor !== undefined;
  const limit = query.limit ?? DEFAULT_FLAGGED_LIMIT;
  const cursor = decodeCursor(query.cursor);

  // limit + 1 on each side, then merge and slice — the same over-fetch
  // `search` uses to learn whether another page exists without a count.
  const [expenses, sales] = await Promise.all([
    expenseRecordService.listFlaggedExpenseRecords(userId, query.businessProfileId, {
      take: limit + 1,
      cursor: cursor
        ? {
            date: new Date(cursor.date),
            id: cursor.id,
            mode: cursor.type === "expense" ? ("same-type" as const) : ("exclude-key" as const),
          }
        : undefined,
    }),
    salesRecordService.listFlaggedSalesRecords(userId, query.businessProfileId, {
      take: limit + 1,
      cursor: cursor
        ? {
            date: new Date(cursor.date),
            id: cursor.id,
            mode: cursor.type === "sales" ? ("same-type" as const) : ("include-key" as const),
          }
        : undefined,
    }),
  ]);

  const merged = [...expenses, ...sales].sort(compareRecords);
  const items = merged.slice(0, limit);
  const last = items.at(-1);
  const nextCursor =
    merged.length > limit && last
      ? Buffer.from(JSON.stringify({ date: last.date.toISOString(), type: last.type, id: last.id })).toString("base64url")
      : null;

  if (paginated) {
    res.status(200).json({ items, nextCursor });
    return;
  }

  // Legacy shape. The header is how an un-updated client can at least tell
  // that it is no longer seeing everything.
  if (nextCursor) res.setHeader("X-Next-Cursor", nextCursor);
  res.status(200).json(items);
}

/**
 * The badge number on its own — two COUNTs instead of the whole list.
 *
 * Ownership-scoped through the same `requireOwnedBusinessProfile` gate as the
 * list, so asking for another business's count answers 404 and cannot be used
 * to learn that the profile exists at all.
 */
export async function flaggedCount(req: Request, res: Response) {
  const query = z.object({ businessProfileId: z.coerce.number().int().positive() }).parse(req.query);
  const userId = req.user!.id;

  const [expenses, sales] = await Promise.all([
    expenseRecordService.countFlaggedExpenseRecords(userId, query.businessProfileId),
    salesRecordService.countFlaggedSalesRecords(userId, query.businessProfileId),
  ]);

  res.status(200).json({ expenses, sales, total: expenses + sales });
}
