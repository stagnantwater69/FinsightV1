import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const { authByToken } = vi.hoisted(() => ({
  authByToken: new Map<string, string>(),
}));

vi.mock("../../src/config/supabase", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/config/supabase")>();
  return {
    ...actual,
    supabaseAdmin: {
      auth: {
        admin: { deleteUser: async () => ({ data: {}, error: null }) },
        getUser: async (token: string) => {
          const authId = authByToken.get(token);
          return authId
            ? { data: { user: { id: authId } }, error: null }
            : { data: { user: null }, error: new Error("bad token") };
        },
      },
    },
  };
});

import request from "supertest";
import { app } from "../../src/app";
import { prisma } from "../../src/config/prisma";
import { resetRateLimits } from "../../src/middleware/rateLimit.middleware";
import {
  RECEIPT_DUPLICATE_CANDIDATE_SET_LIMIT,
  RECEIPT_DUPLICATE_CONFIRM_RESPONSE_LIMIT,
  refreshReceiptDuplicateCandidatesForScan,
} from "../../src/services/receiptDuplicate.service";
import { disconnectDb, makeOwnerWithProfile, resetDb } from "../setup/testDb";

const RECEIPTS = "/api/v1/records/receipts";
const DAY = new Date("2026-09-13T00:00:00.000Z");
const auth = (token: string) => ["Authorization", `Bearer ${token}`] as const;

let owner: Awaited<ReturnType<typeof makeOwnerWithProfile>>;
let other: Awaited<ReturnType<typeof makeOwnerWithProfile>>;

beforeEach(async () => {
  await resetDb();
  resetRateLimits();
  owner = await makeOwnerWithProfile({}, ["Inventory"]);
  other = await makeOwnerWithProfile({ name: "Other Store" }, ["Inventory"]);
  authByToken.clear();
  authByToken.set("owner-token", owner.user.authId);
  authByToken.set("other-token", other.user.authId);
});

afterAll(disconnectDb);

function makeSource(profile = owner, vendor = "Bound Merchant", amount = 250) {
  return prisma.receiptScan.create({
    data: {
      businessProfileId: profile.profile.id,
      imageFile: `${profile.profile.id}/bounds-${Date.now()}-${Math.random()}.jpg`,
      extractedDate: DAY,
      extractedVendor: vendor,
      extractedDescription: "Bounded source",
      extractedAmount: amount,
      processingStatus: "Complete",
      confirmationStatus: "Pending",
    },
  });
}

function seedManualMatches(profile: typeof owner, count: number, vendor = "Bound Merchant", amount = 250) {
  return prisma.expenseRecord.createMany({
    data: Array.from({ length: count }, (_, index) => ({
      businessProfileId: profile.profile.id,
      categoryId: profile.categories.Inventory!,
      date: DAY,
      description: `Prior manual expense ${index + 1}`,
      vendor,
      amount,
      source: "MANUAL_ENTRY" as const,
    })),
  });
}

function refresh(scanId: number, businessProfileId = owner.profile.id) {
  return prisma.$transaction((tx) => refreshReceiptDuplicateCandidatesForScan(tx, scanId, businessProfileId));
}

function decodeCursor(cursor: string): number {
  return (JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { id: number }).id;
}

async function pendingRows(sourceReceiptScanId: number) {
  return prisma.receiptDuplicateCandidate.findMany({
    where: { sourceReceiptScanId, reviewStatus: "PENDING" },
    orderBy: { id: "asc" },
    select: { id: true, candidateExpenseRecordId: true, candidateReceiptScanId: true, createdAt: true },
  });
}

describe("duplicate-candidate list pagination", () => {
  it("pages in the database: no candidate read with targets exceeds take + 1 rows", async () => {
    await seedManualMatches(owner, 25);
    const source = await makeSource();
    await refresh(source.id);

    const original = prisma.receiptDuplicateCandidate.findMany;
    const targetReads: number[] = [];
    prisma.receiptDuplicateCandidate.findMany = (async (args: Parameters<typeof original>[0]) => {
      const rows = await original.call(prisma.receiptDuplicateCandidate, args);
      if (args && "include" in args && args.include) targetReads.push((rows as unknown[]).length);
      return rows;
    }) as typeof original;
    try {
      const response = await request(app)
        .get(`${RECEIPTS}/${source.id}/duplicate-candidates`)
        .query({ take: 5 })
        .set(...auth("owner-token"));
      expect(response.status).toBe(200);
      expect(response.body.candidates).toHaveLength(5);
      expect(response.body.candidateCount).toBe(25);
      expect(response.body.candidatesTruncated).toBe(true);
      expect(targetReads.length).toBeGreaterThan(0);
      expect(Math.max(...targetReads)).toBeLessThanOrEqual(6);
    } finally {
      prisma.receiptDuplicateCandidate.findMany = original;
    }
  });

  it("walks every page in ascending id order with exact cursor boundaries and a stable set hash", async () => {
    await seedManualMatches(owner, 7);
    const source = await makeSource();
    await refresh(source.id);
    const rows = await pendingRows(source.id);
    expect(rows).toHaveLength(7);

    const seen: number[] = [];
    let cursor: string | undefined;
    let hash: string | null = null;
    for (let pageIndex = 0; pageIndex < 3; pageIndex += 1) {
      const response = await request(app)
        .get(`${RECEIPTS}/${source.id}/duplicate-candidates`)
        .query({ take: 3, ...(cursor ? { cursor } : {}) })
        .set(...auth("owner-token"));
      expect(response.status).toBe(200);
      expect(response.body.candidateCount).toBe(7);
      hash ??= response.body.candidateSetHash;
      expect(response.body.candidateSetHash).toBe(hash);
      const ids = response.body.candidates.map((candidate: { id: number }) => candidate.id) as number[];
      expect(ids).toHaveLength(pageIndex === 2 ? 1 : 3);
      seen.push(...ids);
      if (pageIndex < 2) {
        expect(response.body.candidatesTruncated).toBe(true);
        expect(decodeCursor(response.body.nextCursor)).toBe(ids.at(-1));
        cursor = response.body.nextCursor;
      } else {
        expect(response.body.candidatesTruncated).toBe(false);
        expect(response.body.nextCursor).toBeNull();
      }
    }
    expect(seen).toEqual(rows.map((row) => row.id));
    expect([...seen].sort((a, b) => a - b)).toEqual(seen);

    const pastEnd = await request(app)
      .get(`${RECEIPTS}/${source.id}/duplicate-candidates`)
      .query({ take: 3, cursor: Buffer.from(JSON.stringify({ v: 1, id: rows.at(-1)!.id })).toString("base64url") })
      .set(...auth("owner-token"));
    expect(pastEnd.status).toBe(200);
    expect(pastEnd.body).toMatchObject({
      candidateCount: 7,
      candidateSetHash: hash,
      candidates: [],
      candidatesTruncated: false,
      nextCursor: null,
    });

    const exactBoundary = await request(app)
      .get(`${RECEIPTS}/${source.id}/duplicate-candidates`)
      .query({ take: 6, cursor: Buffer.from(JSON.stringify({ v: 1, id: rows[0]!.id })).toString("base64url") })
      .set(...auth("owner-token"));
    expect(exactBoundary.body.candidates.map((candidate: { id: number }) => candidate.id)).toEqual(
      rows.slice(1).map((row) => row.id),
    );
    expect(exactBoundary.body.candidatesTruncated).toBe(false);
    expect(exactBoundary.body.nextCursor).toBeNull();

    for (const bad of ["not-base64", Buffer.from(JSON.stringify({ v: 2, id: 1 })).toString("base64url")]) {
      const rejected = await request(app)
        .get(`${RECEIPTS}/${source.id}/duplicate-candidates`)
        .query({ cursor: bad })
        .set(...auth("owner-token"));
      expect(rejected.status).toBe(400);
    }
  });
});

describe("oversized duplicate-candidate sets", () => {
  it("caps persistence, listing, and the confirm decision at the documented limit", async () => {
    const overflow = 30;
    await seedManualMatches(owner, RECEIPT_DUPLICATE_CANDIDATE_SET_LIMIT + overflow);
    const source = await makeSource();
    await refresh(source.id);

    const rows = await pendingRows(source.id);
    expect(rows).toHaveLength(RECEIPT_DUPLICATE_CANDIDATE_SET_LIMIT);
    const kept = rows.map((row) => row.candidateExpenseRecordId!);
    const oldest = (await prisma.expenseRecord.findMany({
      where: { businessProfileId: owner.profile.id },
      orderBy: { id: "asc" },
      take: RECEIPT_DUPLICATE_CANDIDATE_SET_LIMIT,
      select: { id: true },
    })).map((record) => record.id);
    expect(kept).toEqual(oldest);

    await refresh(source.id);
    expect((await pendingRows(source.id)).map((row) => row.id)).toEqual(rows.map((row) => row.id));
    expect(await prisma.receiptDuplicateCandidate.count({ where: { sourceReceiptScanId: source.id } }))
      .toBe(RECEIPT_DUPLICATE_CANDIDATE_SET_LIMIT);

    const body = {
      expectedScanRevision: 0,
      date: "2026-09-13",
      vendor: "Bound Merchant",
      description: "Bounded confirm",
      amount: 250,
      splits: [{ categoryId: owner.categories.Inventory, amount: 250 }],
    };
    const review = await request(app)
      .post(`${RECEIPTS}/${source.id}/confirm`)
      .set(...auth("owner-token"))
      .send(body);
    expect(review.status).toBe(409);
    expect(review.body).toMatchObject({
      code: "DUPLICATE_REVIEW_REQUIRED",
      candidateCount: RECEIPT_DUPLICATE_CANDIDATE_SET_LIMIT,
      candidatesTruncated: true,
    });
    expect(review.body.candidates).toHaveLength(RECEIPT_DUPLICATE_CONFIRM_RESPONSE_LIMIT);

    const ids = new Set<number>();
    let cursor: string | null = null;
    let pages = 0;
    do {
      const response: { status: number; body: { candidates: { id: number }[]; nextCursor: string | null; candidateSetHash: string; candidateCount: number } } = await request(app)
        .get(`${RECEIPTS}/${source.id}/duplicate-candidates`)
        .query({ take: 50, ...(cursor ? { cursor } : {}) })
        .set(...auth("owner-token"));
      expect(response.status).toBe(200);
      expect(response.body.candidateSetHash).toBe(review.body.candidateSetHash);
      expect(response.body.candidateCount).toBe(RECEIPT_DUPLICATE_CANDIDATE_SET_LIMIT);
      for (const candidate of response.body.candidates) ids.add(candidate.id);
      cursor = response.body.nextCursor;
      pages += 1;
    } while (cursor);
    expect(pages).toBe(Math.ceil(RECEIPT_DUPLICATE_CANDIDATE_SET_LIMIT / 50));
    expect(ids.size).toBe(RECEIPT_DUPLICATE_CANDIDATE_SET_LIMIT);

    const saved = await request(app)
      .post(`${RECEIPTS}/${source.id}/confirm`)
      .set(...auth("owner-token"))
      .send({ ...body, duplicateDecision: { action: "SAVE_ANYWAY", candidateSetHash: review.body.candidateSetHash } });
    expect(saved.status).toBe(201);
    expect(await prisma.receiptDuplicateCandidate.count({
      where: { sourceReceiptScanId: source.id, reviewStatus: "SAVED_ANYWAY" },
    })).toBe(RECEIPT_DUPLICATE_CANDIDATE_SET_LIMIT);
  });
});

describe("repeated and concurrent candidate persistence", () => {
  it("still discovers an exact-image and same-total match beyond the cap's worth of same-date scans", async () => {
    // More than the cap of older confirmed scans on the receipt's date, none of
    // them a match, then one newer confirmed scan that is byte-identical and
    // has the same vendor and total.
    const fillerCount = RECEIPT_DUPLICATE_CANDIDATE_SET_LIMIT + 5;
    for (let index = 0; index < fillerCount; index += 1) {
      await prisma.receiptScan.create({
        data: {
          businessProfileId: owner.profile.id,
          imageFile: `${owner.profile.id}/filler-${index}.jpg`,
          extractedDate: DAY,
          extractedVendor: `Filler ${index}`,
          extractedAmount: 1000 + index,
          processingStatus: "Complete",
          confirmationStatus: "Confirmed",
          expenseRecords: {
            create: {
              businessProfileId: owner.profile.id,
              categoryId: owner.categories.Inventory!,
              date: DAY,
              description: `Filler ${index}`,
              vendor: `Filler ${index}`,
              amount: 1000 + index,
              source: "RECEIPT_SCAN",
            },
          },
        },
      });
    }
    const hash = "a".repeat(64);
    const twin = await prisma.receiptScan.create({
      data: {
        businessProfileId: owner.profile.id,
        imageFile: `${owner.profile.id}/twin.jpg`,
        sourceImageHash: hash,
        extractedDate: DAY,
        extractedVendor: "Bound Merchant",
        extractedAmount: 250,
        processingStatus: "Complete",
        confirmationStatus: "Confirmed",
        expenseRecords: {
          create: {
            businessProfileId: owner.profile.id,
            categoryId: owner.categories.Inventory!,
            date: DAY,
            description: "Twin",
            vendor: "Bound Merchant",
            amount: 250,
            source: "RECEIPT_SCAN",
          },
        },
      },
    });
    const source = await makeSource();
    await prisma.receiptScan.update({ where: { id: source.id }, data: { sourceImageHash: hash } });

    await refresh(source.id);

    const rows = await pendingRows(source.id);
    expect(rows.map((row) => row.candidateReceiptScanId)).toContain(twin.id);
    const twinRow = await prisma.receiptDuplicateCandidate.findFirstOrThrow({
      where: { sourceReceiptScanId: source.id, candidateReceiptScanId: twin.id },
    });
    expect(twinRow.reasonCodes).toContain("EXACT_IMAGE");
  });

  it("re-running the refresh writes no duplicate rows and keeps the original row identities", async () => {
    await seedManualMatches(owner, 5);
    const source = await makeSource();
    await refresh(source.id);
    const first = await pendingRows(source.id);
    expect(first).toHaveLength(5);

    await refresh(source.id);
    await refresh(source.id);
    const again = await pendingRows(source.id);
    expect(again).toEqual(first);
    expect(await prisma.receiptDuplicateCandidate.count({ where: { sourceReceiptScanId: source.id } })).toBe(5);
  });

  it("supersedes stale rows in bulk and revives them without creating a second row per target", async () => {
    await seedManualMatches(owner, 3);
    const source = await makeSource();
    await refresh(source.id);
    const original = await pendingRows(source.id);
    expect(original).toHaveLength(3);

    await prisma.receiptScan.update({ where: { id: source.id }, data: { extractedVendor: "Unrelated Merchant" } });
    await refresh(source.id);
    expect(await pendingRows(source.id)).toHaveLength(0);
    expect(await prisma.receiptDuplicateCandidate.count({
      where: { sourceReceiptScanId: source.id, reviewStatus: "SUPERSEDED" },
    })).toBe(3);

    await prisma.receiptScan.update({ where: { id: source.id }, data: { extractedVendor: "Bound Merchant" } });
    await refresh(source.id);
    const revived = await pendingRows(source.id);
    expect(revived.map((row) => row.id)).toEqual(original.map((row) => row.id));
    expect(await prisma.receiptDuplicateCandidate.count({ where: { sourceReceiptScanId: source.id } })).toBe(3);
  });

  it("serializes concurrent refreshes of one scan so each target has exactly one row", async () => {
    await seedManualMatches(owner, 12);
    const source = await makeSource();
    await Promise.all(Array.from({ length: 4 }, () => refresh(source.id)));

    const rows = await pendingRows(source.id);
    expect(rows).toHaveLength(12);
    expect(new Set(rows.map((row) => row.candidateExpenseRecordId)).size).toBe(12);
    expect(await prisma.receiptDuplicateCandidate.count({ where: { sourceReceiptScanId: source.id } })).toBe(12);
  });
});

describe("duplicate-candidate profile isolation", () => {
  it("never returns or modifies another profile's candidate rows", async () => {
    await seedManualMatches(other, 4);
    const foreignSource = await makeSource(other);
    await refresh(foreignSource.id, other.profile.id);
    const foreignBefore = await prisma.receiptDuplicateCandidate.findMany({
      where: { businessProfileId: other.profile.id },
      orderBy: { id: "asc" },
    });
    expect(foreignBefore).toHaveLength(4);

    await seedManualMatches(owner, 2);
    const source = await makeSource();
    await refresh(source.id);
    await refresh(source.id);

    const list = await request(app)
      .get(`${RECEIPTS}/${source.id}/duplicate-candidates`)
      .query({ take: 50 })
      .set(...auth("owner-token"));
    expect(list.status).toBe(200);
    expect(list.body.candidateCount).toBe(2);
    const foreignIds = new Set(foreignBefore.map((row) => row.id));
    for (const candidate of list.body.candidates as { id: number; target: { id: number } }[]) {
      expect(foreignIds.has(candidate.id)).toBe(false);
    }

    const foreignRead = await request(app)
      .get(`${RECEIPTS}/${source.id}/duplicate-candidates`)
      .set(...auth("other-token"));
    expect(foreignRead.status).toBe(404);

    const confirmed = await request(app)
      .post(`${RECEIPTS}/${source.id}/confirm`)
      .set(...auth("owner-token"))
      .send({
        // Same final values as the scan's extracted ones, so the list hash
        // (computed from the OCR fingerprint) is the hash the confirm sees.
        expectedScanRevision: 0,
        date: "2026-09-13",
        vendor: "Bound Merchant",
        description: "Bounded source",
        amount: 250,
        splits: [{ categoryId: owner.categories.Inventory, amount: 250 }],
        duplicateDecision: { action: "SAVE_ANYWAY", candidateSetHash: list.body.candidateSetHash },
      });
    expect(confirmed.status).toBe(201);

    const foreignAfter = await prisma.receiptDuplicateCandidate.findMany({
      where: { businessProfileId: other.profile.id },
      orderBy: { id: "asc" },
    });
    expect(foreignAfter).toEqual(foreignBefore);
    expect(await prisma.receiptDuplicateCandidate.count({
      where: { businessProfileId: owner.profile.id, reviewStatus: "SAVED_ANYWAY" },
    })).toBe(2);
  });
});

describe("duplicate-candidate cursor tampering", () => {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

  it("answers every malformed cursor with the same 400 and no candidate data", async () => {
    await seedManualMatches(owner, 3);
    const source = await makeSource();
    await refresh(source.id);

    const tampered: [string, string][] = [
      ["wrong version", encode({ v: 2, id: 1 })],
      ["negative id", encode({ v: 1, id: -1 })],
      ["zero id", encode({ v: 1, id: 0 })],
      ["string id", encode({ v: 1, id: "1" })],
      ["fractional id", encode({ v: 1, id: 1.5 })],
      ["missing id", encode({ v: 1 })],
      ["array body", encode([1, 2])],
      ["null body", encode(null)],
      ["not base64url", "!!!not-a-cursor@@@"],
      ["bare number", encode(7)],
    ];

    for (const [label, cursor] of tampered) {
      const response = await request(app)
        .get(`${RECEIPTS}/${source.id}/duplicate-candidates`)
        .query({ cursor })
        .set(...auth("owner-token"));
      expect(response.status, label).toBe(400);
      expect(response.body, label).not.toHaveProperty("candidates");
      expect(JSON.stringify(response.body), label).not.toContain("Bound Merchant");
      expect(JSON.stringify(response.body), label).not.toContain("Prior manual expense");
    }
  });

  it("a cursor naming another profile's candidate row still pages only the caller's own rows", async () => {
    await seedManualMatches(other, 3);
    const foreignSource = await makeSource(other);
    await refresh(foreignSource.id, other.profile.id);
    const foreignRows = await pendingRows(foreignSource.id);
    expect(foreignRows).toHaveLength(3);

    await seedManualMatches(owner, 2);
    const source = await makeSource();
    await refresh(source.id);
    const ownRows = await pendingRows(source.id);
    expect(ownRows).toHaveLength(2);

    // The foreign rows were persisted first, so their last id sits below every
    // own row: paging after it yields the whole own set. Paging after the
    // highest id of all yields nothing. Neither ever yields a foreign row.
    const lastForeign = foreignRows[foreignRows.length - 1]!.id;
    expect(lastForeign).toBeLessThan(ownRows[0]!.id);
    const highest = Math.max(lastForeign, ownRows[ownRows.length - 1]!.id);
    for (const [afterId, expectedCount] of [[lastForeign, 2], [highest, 0]] as const) {
      const response = await request(app)
        .get(`${RECEIPTS}/${source.id}/duplicate-candidates`)
        .query({ cursor: encode({ v: 1, id: afterId }), take: 50 })
        .set(...auth("owner-token"));
      expect(response.status).toBe(200);
      expect(response.body.candidates).toHaveLength(expectedCount);
      expect(response.body.candidateCount).toBe(2);
      for (const candidate of response.body.candidates as { id: number }[]) {
        expect(ownRows.map((row) => row.id)).toContain(candidate.id);
      }
    }
  });

  /*
   * Was a pinned defect (QA, 2026-09-14): a path or cursor id past int4
   * reached Prisma and surfaced as a 500 from client-controlled input. Both
   * decoders now bound the id; these cases keep them that way.
   */
  it("a path id past the int4 range is refused as a bad id, not a server error", async () => {
    for (const path of [
      `${RECEIPTS}/2147483648`,
      `${RECEIPTS}/2147483648/duplicate-candidates`,
      `/api/v1/records/receipt-batches/2147483648`,
    ]) {
      const response = await request(app).get(path).set(...auth("owner-token"));
      expect(response.status, path).toBe(400);
      expect(response.body.error, path).toMatch(/Invalid receipt/);
    }
    const item = await request(app)
      .patch(`${RECEIPTS}/1/items/2147483648`)
      .set(...auth("owner-token"))
      .send({ name: "x", amount: 1 });
    expect(item.status).toBe(400);
    expect(item.body.error).toMatch(/Invalid receipt scan item id/);
  });

  it("an id past the int4 range is refused as a bad cursor, not a server error", async () => {
    const source = await makeSource();
    for (const id of [2147483648, Number.MAX_SAFE_INTEGER]) {
      const response = await request(app)
        .get(`${RECEIPTS}/${source.id}/duplicate-candidates`)
        .query({ cursor: encode({ v: 1, id }) })
        .set(...auth("owner-token"));
      expect(response.status, String(id)).toBe(400);
    }
  });

  it("a history cursor id past the int4 range is refused as a bad cursor, not a server error", async () => {
    await makeSource();
    for (const id of [2147483648, Number.MAX_SAFE_INTEGER]) {
      const response = await request(app)
        .get(RECEIPTS)
        .query({
          businessProfileId: owner.profile.id,
          status: "all",
          cursor: encode({ v: 1, createdAt: DAY.toISOString(), id }),
        })
        .set(...auth("owner-token"));
      expect(response.status, String(id)).toBe(400);
      expect(response.body.error, String(id)).toMatch(/Invalid receipt history cursor/);
      expect(response.body.items, String(id)).toBeUndefined();
    }
    // Same shape, in-range id: the refusal above is the bound, not the shape.
    const valid = await request(app)
      .get(RECEIPTS)
      .query({
        businessProfileId: owner.profile.id,
        status: "all",
        cursor: encode({ v: 1, createdAt: DAY.toISOString(), id: 2147483647 }),
      })
      .set(...auth("owner-token"));
    expect(valid.status).toBe(200);
  });
});
