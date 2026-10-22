/*
 * Checks AvailableFundsDailyTotal against the records it summarises.
 *
 *   npm run ops:available-funds:check                     # every business, read-only
 *   npm run ops:available-funds:check -- --business 42    # one business
 *   npm run ops:available-funds:check -- --repair         # write the corrected totals
 *
 * How: inside one transaction it copies the totals, recomputes every day that
 * holds a record or a total with the database's own recompute function (the
 * same one the triggers use, so the eligibility rules exist in one place),
 * compares, and rolls back unless --repair was given. The recompute briefly
 * takes each business's funds lock, so writers to a business wait while it
 * is checked.
 *
 * Uses DATABASE_URL. A host other than localhost needs --allow-remote, so a
 * check against the hosted project is always a deliberate choice.
 * Exit 0: totals match (or were repaired). 1: mismatches found. 2: bad input.
 */
import "dotenv/config";
import { Prisma, PrismaClient } from "@prisma/client";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "host.docker.internal"]);

class RollBack extends Error {}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<number> {
  const repair = process.argv.includes("--repair");
  const businessArg = argument("--business");
  const businessId = businessArg === undefined ? undefined : Number(businessArg);
  if (businessId !== undefined && (!Number.isInteger(businessId) || businessId < 1)) {
    console.error("--business needs a positive integer id");
    return 2;
  }
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set");
    return 2;
  }
  const host = new URL(url).hostname;
  if (!LOCAL_HOSTS.has(host) && !process.argv.includes("--allow-remote")) {
    console.error(`Refusing to check ${host} without --allow-remote.`);
    return 2;
  }

  const prisma = new PrismaClient({ datasources: { db: { url } } });
  const scope = businessId === undefined ? Prisma.sql`TRUE` : Prisma.sql`"BusinessProfile_ID" = ${businessId}`;
  let mismatches: { business: number; day: string; before: string; after: string }[] = [];
  try {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`
        CREATE TEMP TABLE funds_before ON COMMIT DROP AS
        SELECT * FROM "AvailableFundsDailyTotal" WHERE ${scope}`;
      await tx.$executeRaw`
        SELECT finsight_refresh_available_funds_days(array_agg(pair.profile_id), array_agg(pair.day))
        FROM (
          SELECT "BusinessProfile_ID" AS profile_id, "ExpenseRecord_Date" AS day FROM "ExpenseRecord" WHERE ${scope}
          UNION
          SELECT "BusinessProfile_ID", "SalesReferenceRecord_Date" FROM "SalesReferenceRecord" WHERE ${scope}
          UNION
          SELECT "BusinessProfile_ID", "AvailableFundsDailyTotal_Date" FROM funds_before
        ) pair`;
      mismatches = await tx.$queryRaw`
        SELECT COALESCE(b."BusinessProfile_ID", a."BusinessProfile_ID") AS business,
               to_char(COALESCE(b."AvailableFundsDailyTotal_Date", a."AvailableFundsDailyTotal_Date"), 'YYYY-MM-DD') AS day,
               CASE WHEN b."BusinessProfile_ID" IS NULL THEN 'none'
                    ELSE concat_ws(' ', b."AvailableFundsDailyTotal_SalesAmount", b."AvailableFundsDailyTotal_SalesCount",
                                   b."AvailableFundsDailyTotal_ExpenseAmount", b."AvailableFundsDailyTotal_ExpenseCount") END AS before,
               CASE WHEN a."BusinessProfile_ID" IS NULL THEN 'none'
                    ELSE concat_ws(' ', a."AvailableFundsDailyTotal_SalesAmount", a."AvailableFundsDailyTotal_SalesCount",
                                   a."AvailableFundsDailyTotal_ExpenseAmount", a."AvailableFundsDailyTotal_ExpenseCount") END AS after
        FROM funds_before b
        FULL JOIN (SELECT * FROM "AvailableFundsDailyTotal" WHERE ${scope}) a
          ON a."BusinessProfile_ID" = b."BusinessProfile_ID" AND a."AvailableFundsDailyTotal_Date" = b."AvailableFundsDailyTotal_Date"
        WHERE ROW(b."AvailableFundsDailyTotal_SalesAmount", b."AvailableFundsDailyTotal_SalesCount",
                  b."AvailableFundsDailyTotal_ExpenseAmount", b."AvailableFundsDailyTotal_ExpenseCount")
              IS DISTINCT FROM
              ROW(a."AvailableFundsDailyTotal_SalesAmount", a."AvailableFundsDailyTotal_SalesCount",
                  a."AvailableFundsDailyTotal_ExpenseAmount", a."AvailableFundsDailyTotal_ExpenseCount")
        ORDER BY 1, 2`;
      if (!repair) throw new RollBack();
    }, { timeout: 10 * 60_000, maxWait: 30_000 });
  } catch (error) {
    if (!(error instanceof RollBack)) throw error;
  } finally {
    await prisma.$disconnect();
  }

  if (mismatches.length === 0) {
    console.log("available-funds totals match the records.");
    return 0;
  }
  console.log(`${mismatches.length} day(s) differ (sales amount, count, expense amount, count):`);
  for (const row of mismatches.slice(0, 50)) {
    console.log(`  business ${row.business} ${row.day}: stored ${row.before} -> records ${row.after}`);
  }
  if (repair) {
    console.log("Repaired.");
    return 0;
  }
  console.log("Nothing was changed. Rerun with --repair to write the corrected totals.");
  return 1;
}

main().then(
  (code) => { process.exitCode = code; },
  (error) => { console.error(error); process.exitCode = 2; },
);
