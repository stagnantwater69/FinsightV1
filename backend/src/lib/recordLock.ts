import type { Prisma } from "@prisma/client";
import type { prisma } from "../config/prisma";

type DbClient = Prisma.TransactionClient | typeof prisma;

/**
 * Second key of the two-int advisory-lock space, so a records lock can never
 * be confused with recoveryNotification.service's per-trigger lock on the same
 * business profile. That one uses small indexes (0, 1, 2, ...); these are
 * hashes deliberately kept away from that range.
 */
const LOCK_HASH_FLOOR = 1_000;

/**
 * A stable 32-bit hash of the duplicate key.
 *
 * Postgres' own `hashtext` would do, but computing it here keeps the lock a
 * plain two-int `pg_advisory_xact_lock(profileId, hash)` — the exact shape
 * recoveryNotification.service already uses — instead of a second, different
 * advisory-lock convention. FNV-1a, folded into the positive int range.
 */
function hashKey(key: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  // >>> 1 keeps it inside a positive signed 32-bit int, which is what the
  // two-argument advisory-lock form takes.
  return LOCK_HASH_FLOOR + ((hash >>> 1) % (0x7fffffff - LOCK_HASH_FLOOR));
}

/**
 * SERIALISES CONCURRENT CREATES OF THE SAME LOGICAL RECORD.
 *
 * A transaction alone does not fix a double-tap on Add Expense. At READ
 * COMMITTED — Postgres' default, and what Prisma uses — two concurrent
 * transactions both run the duplicate SELECT before either has inserted, both
 * see nothing, and both insert. The books gain two identical records and the
 * duplicate detector, whose whole job this is, marks neither: the owner is
 * never told, because from each transaction's point of view there genuinely
 * was no duplicate at the moment it looked.
 *
 * A transaction-scoped advisory lock keyed on (business profile, duplicate
 * identity) is what makes the read-then-write actually atomic. The second tap
 * waits for the first to commit, then sees the record it wrote and flags
 * itself. Nothing is rejected — a genuine second identical purchase is still
 * recorded, exactly as before, and still flagged for the owner to judge. Only
 * the ORDER changes, from "both blind" to "one after the other".
 *
 * `pg_advisory_xact_lock` releases at transaction end, commit or rollback, so
 * a failed create cannot strand the lock. Called outside a transaction it is
 * released at the end of the implicit one — harmless, but pointless, so
 * callers take it inside `$transaction`.
 */
export async function lockDuplicateKey(db: DbClient, businessProfileId: number, key: string): Promise<void> {
  await db.$executeRaw`SELECT pg_advisory_xact_lock(${businessProfileId}::int, ${hashKey(key)}::int)`;
}

const EXPENSE_DUPLICATE_WRITE_GATE = "expense-duplicate-write-gate:v1";

/** Acquired before narrower locks so manual, CSV, and receipt duplicate checks cannot race. */
export function lockExpenseDuplicateWriteGate(
  db: DbClient,
  businessProfileId: number,
): Promise<void> {
  return lockDuplicateKey(db, businessProfileId, EXPENSE_DUPLICATE_WRITE_GATE);
}
