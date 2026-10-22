/*
 * How the records screen and dashboard reads behave as one business's ledger
 * grows, measured rather than assumed, so an index is added only where a plan
 * shows it is needed.
 *
 * For each ledger size it seeds one business (70% expenses, 30% sales, dates
 * over three years, a word list of descriptions) beside two neighbouring
 * businesses of 50,000 records each, ANALYZEs, then calls the same service
 * functions the routes call:
 *
 *   1. a timing pass: PLAN_RUNS runs per scenario after one warm-up, median
 *      and slowest reported, with plan logging off so it costs nothing;
 *   2. a plan pass, when PLAN_CONTAINER names the Postgres container: one more
 *      run per scenario with auto_explain on, plans read back from its log.
 *
 * Throwaway database only. It TRUNCATEs every table, and refuses anything but a
 * local database named finsight_test:
 *
 *   docker run -d --name finsight-plans-db -p 127.0.0.1:55441:5432 \
 *     -e POSTGRES_USER=testuser -e POSTGRES_PASSWORD=testpass -e POSTGRES_DB=finsight_test \
 *     postgres:16-alpine -c shared_preload_libraries=auto_explain -c log_line_prefix='%a '
 *   export DATABASE_URL='postgresql://testuser:testpass@127.0.0.1:55441/finsight_test?connection_limit=1'
 *   export DIRECT_URL="$DATABASE_URL"
 *   npx prisma migrate deploy
 *   PLAN_CONTAINER=finsight-plans-db npx tsx tests/load/query-plans.ts > plans.md
 *
 * connection_limit=1 is required: each scenario tags its queries by setting
 * application_name on the session, which only works on a single connection.
 * Knobs: PLAN_SIZES (default 10000,100000,500000), PLAN_RUNS (default 5).
 */
import { spawnSync } from "node:child_process";
import { assertLocalTestDatabase } from "../setup/globalSetup";

const databaseUrl = process.env.DATABASE_URL ?? "";
assertLocalTestDatabase("DATABASE_URL", databaseUrl);
assertLocalTestDatabase("DIRECT_URL", process.env.DIRECT_URL ?? "");
if (new URL(databaseUrl).searchParams.get("connection_limit") !== "1") {
  throw new Error("DATABASE_URL needs ?connection_limit=1 so each scenario's application_name tag applies to its queries.");
}
// Set before any app module loads: src/config/env.ts reads backend/.env through
// dotenv, which never overrides a variable that is already set. Nothing here
// calls Supabase.
process.env.SUPABASE_URL ??= "http://127.0.0.1:54321";
process.env.SUPABASE_ANON_KEY ??= "query-plans-placeholder";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "query-plans-placeholder";
process.env.NODE_ENV ??= "test";

const SIZES = (process.env.PLAN_SIZES ?? "10000,100000,500000").split(",").map(Number);
const RUNS = Number(process.env.PLAN_RUNS ?? 5);
const CONTAINER = process.env.PLAN_CONTAINER;
const NEIGHBOUR_RECORDS = 50_000;
const PAGE = 50;

type Scenario = { name: string; run: () => Promise<unknown> };

async function main() {
  const { Prisma } = await import("@prisma/client");
  const { prisma } = await import("../../src/config/prisma");
  const { resetDb, makeOwnerWithProfile } = await import("../setup/testDb");
  const expenses = await import("../../src/services/expenseRecord.service");
  const sales = await import("../../src/services/salesRecord.service");
  const { findRecordAtPosition } = await import("../../src/services/recordPosition.service");
  const { listRecordMonths } = await import("../../src/services/recordMonths.service");
  const { getDashboardSummary } = await import("../../src/services/dashboard.service");
  const { getExpenseOverview } = await import("../../src/services/expenseOverview.service");

  const CATEGORIES = ["Inventory", "Utilities", "Rent", "Transport", "Supplies", "Salaries", "Repairs", "Marketing"];
  const WORDS = ["Rice sacks", "Electric bill", "Cooking oil", "Delivery fee", "Store rent", "Egg trays",
    "Sugar", "Coffee beans", "Plastic bags", "Water refill", "Softdrinks case", "Canned goods"];

  /** Inserts `count` records for one business in two set-based statements. */
  async function seed(businessProfileId: number, categoryIds: number[], count: number) {
    const expenseCount = Math.round(count * 0.7);
    const salesCount = count - expenseCount;
    const words = Prisma.sql`ARRAY[${Prisma.join(WORDS)}]::text[]`;
    const categories = Prisma.sql`ARRAY[${Prisma.join(categoryIds)}]::int[]`;
    // Dates over three years ending today; amounts from 5.00 to ~25,000 with
    // many small values; ~2% needing review and ~1% flagged as duplicates.
    await prisma.$executeRaw`
      INSERT INTO "ExpenseRecord" (
        "BusinessProfile_ID", "Category_ID", "ExpenseRecord_Date", "ExpenseRecord_Description",
        "ExpenseRecord_Vendor", "ExpenseRecord_Amount", "ExpenseRecord_Source", "ExpenseRecord_ReviewStatus",
        "ExpenseRecord_DuplicateStatus", "ExpenseRecord_LargeExpenseFlag", "ExpenseRecord_CreatedAt"
      )
      SELECT ${businessProfileId},
        (${categories})[(1 + n % ${categoryIds.length})::int],
        CURRENT_DATE - ((n * 7919) % 1095)::int,
        (${words})[(1 + n % ${WORDS.length})::int] || ' #' || n,
        CASE WHEN n % 3 = 0 THEN 'Supplier ' || (n % 40) END,
        round((5 + power(((n * 2654435761) % 1000) / 1000.0, 3) * 25000)::numeric, 2),
        (CASE WHEN n % 4 = 0 THEN 'CSV Upload' ELSE 'Manual Entry' END)::"ExpenseRecordSource",
        CASE WHEN n % 50 = 0 THEN 'Needs Review' ELSE 'Reviewed' END,
        CASE WHEN n % 100 = 0 THEN 'Flagged' ELSE 'Not a Duplicate' END,
        false, NOW()
      FROM generate_series(1::bigint, ${expenseCount}::bigint) AS n`;
    await prisma.$executeRaw`
      INSERT INTO "SalesReferenceRecord" (
        "BusinessProfile_ID", "SalesReferenceRecord_Date", "SalesReferenceRecord_Description",
        "SalesReferenceRecord_Amount", "SalesReferenceRecord_Source", "SalesReferenceRecord_ReviewStatus",
        "SalesReferenceRecord_DuplicateStatus", "SalesReferenceRecord_CreatedAt"
      )
      SELECT ${businessProfileId},
        CURRENT_DATE - ((n * 104729) % 1095)::int,
        'Daily sales ' || n,
        round((200 + ((n * 2654435761) % 1500000) / 100.0)::numeric, 2),
        (CASE WHEN n % 4 = 0 THEN 'CSV Upload' ELSE 'Manual Entry' END)::"SalesRecordSource",
        CASE WHEN n % 50 = 0 THEN 'Needs Review' ELSE 'Reviewed' END,
        CASE WHEN n % 100 = 0 THEN 'Flagged' ELSE 'Not a Duplicate' END,
        NOW()
      FROM generate_series(1::bigint, ${salesCount}::bigint) AS n`;
  }

  function scenarios(userId: number, businessProfileId: number, inventoryId: number, size: number): Scenario[] {
    const base = { businessProfileId };
    /** The search route's work for one page: both halves, plus totals when asked. */
    const searchPage = (
      sort: "date_desc" | "amount_desc",
      filters: { keyword?: string; categoryId?: number } = {},
      includeTotal = false,
    ) =>
      Promise.all([
        expenses.searchExpenseRecords(userId, { ...base, ...filters, sort, take: PAGE + 1 }),
        filters.categoryId === undefined
          ? sales.searchSalesRecords(userId, { ...base, ...filters, sort, take: PAGE + 1 })
          : Promise.resolve([]),
        includeTotal ? expenses.countSearchExpenseRecords(userId, { ...base, ...filters }) : Promise.resolve(0),
        includeTotal && filters.categoryId === undefined
          ? sales.countSearchSalesRecords(userId, { ...base, ...filters })
          : Promise.resolve(0),
      ]);
    const deepOffset = Math.floor(size * 0.8);
    const month = new Date().toISOString().slice(0, 7);
    return [
      { name: "records-first-page-by-date", run: () => searchPage("date_desc", {}, true) },
      { name: "records-first-page-by-amount", run: () => searchPage("amount_desc", {}, true) },
      { name: "records-keyword-search", run: () => searchPage("date_desc", { keyword: "coffee" }, true) },
      { name: "records-category-filter", run: () => searchPage("date_desc", { categoryId: inventoryId }, true) },
      {
        name: "records-jump-deep-by-date",
        run: () => findRecordAtPosition(userId, base, { includeExpenses: true, includeSales: true, sort: "date_desc", offset: deepOffset }),
      },
      {
        name: "records-jump-deep-by-amount",
        run: () => findRecordAtPosition(userId, base, { includeExpenses: true, includeSales: true, sort: "amount_desc", offset: deepOffset }),
      },
      {
        name: "records-flagged-count",
        run: () => Promise.all([
          expenses.countFlaggedExpenseRecords(userId, businessProfileId),
          sales.countFlaggedSalesRecords(userId, businessProfileId),
        ]),
      },
      { name: "records-months", run: () => listRecordMonths(userId, businessProfileId) },
      { name: "dashboard-this-month", run: () => getDashboardSummary(userId, businessProfileId, { kind: "month", month }) },
      { name: "dashboard-all-time", run: () => getDashboardSummary(userId, businessProfileId, 0) },
      { name: "expense-overview-this-month", run: () => getExpenseOverview(userId, businessProfileId, { kind: "month", month }, "dashboard") },
    ];
  }

  const tag = (name: string) => prisma.$executeRawUnsafe(`SET application_name = '${name.replace(/[^a-z0-9-]/g, "")}'`);
  const explain = (on: boolean) =>
    prisma.$executeRawUnsafe(`SET auto_explain.log_min_duration = ${on ? 0 : -1}`);

  const results: { size: number; name: string; medianMs: number; maxMs: number }[] = [];
  const plans: { size: number; name: string; durationMs: number; plan: string }[] = [];

  for (const size of SIZES) {
    await resetDb();
    const owner = await makeOwnerWithProfile({}, CATEGORIES);
    for (let i = 0; i < 2; i += 1) {
      const neighbour = await makeOwnerWithProfile({}, CATEGORIES);
      await seed(neighbour.profile.id, Object.values(neighbour.categories), NEIGHBOUR_RECORDS);
    }
    await seed(owner.profile.id, Object.values(owner.categories), size);
    await prisma.$executeRawUnsafe(`ANALYZE "ExpenseRecord"`);
    await prisma.$executeRawUnsafe(`ANALYZE "SalesReferenceRecord"`);
    const list = scenarios(owner.user.id, owner.profile.id, owner.categories.Inventory!, size);

    for (const scenario of list) {
      await scenario.run();
      const times: number[] = [];
      for (let i = 0; i < RUNS; i += 1) {
        const started = performance.now();
        await scenario.run();
        times.push(performance.now() - started);
      }
      times.sort((a, b) => a - b);
      results.push({ size, name: scenario.name, medianMs: times[Math.floor(times.length / 2)]!, maxMs: times.at(-1)! });
    }

    if (CONTAINER) {
      const since = new Date(Date.now() - 1000).toISOString();
      await prisma.$executeRawUnsafe("SET auto_explain.log_analyze = on");
      await prisma.$executeRawUnsafe("SET auto_explain.log_buffers = on");
      await explain(true);
      for (const scenario of list) {
        await tag(`plan-${size}-${scenario.name}`);
        await scenario.run();
      }
      await tag("query-plans");
      await explain(false);
      plans.push(...readPlans(CONTAINER, since, size));
    }
  }

  printReport(results, plans);
  await prisma.$disconnect();
}

/** Plans auto_explain logged for this size, from `docker logs`, keyed by the scenario tag. */
function readPlans(container: string, since: string, size: number) {
  // Postgres logs to stderr, and `docker logs` replays it there.
  const output = spawnSync("docker", ["logs", "--since", since, container], { encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });
  if (output.status !== 0) throw new Error(`docker logs failed: ${output.stderr}`);
  const log = `${output.stdout}\n${output.stderr}`;
  const found: { size: number; name: string; durationMs: number; plan: string }[] = [];
  let current: { size: number; name: string; durationMs: number; lines: string[] } | null = null;
  const flush = () => {
    if (current) found.push({ size: current.size, name: current.name, durationMs: current.durationMs, plan: current.lines.join("\n") });
    current = null;
  };
  for (const line of log.split("\n")) {
    const start = /^plan-(\d+)-(\S+) LOG:\s+duration: ([\d.]+) ms\s+plan:/.exec(line);
    if (start) {
      flush();
      if (Number(start[1]) === size) current = { size, name: start[2]!, durationMs: Number(start[3]), lines: [] };
      continue;
    }
    if (current && /^\s/.test(line)) current.lines.push(line.replace(/^\t/, ""));
    else flush();
  }
  flush();
  return found;
}

function printReport(
  results: { size: number; name: string; medianMs: number; maxMs: number }[],
  plans: { size: number; name: string; durationMs: number; plan: string }[],
) {
  const sizes = [...new Set(results.map((r) => r.size))];
  const names = [...new Set(results.map((r) => r.name))];
  const ms = (value: number) => value.toFixed(1);
  console.log(`# Query timings (median of ${RUNS}, slowest in brackets, ms)\n`);
  console.log(`| Scenario | ${sizes.map((s) => `${s.toLocaleString("en")} records`).join(" | ")} |`);
  console.log(`|---|${sizes.map(() => "---:").join("|")}|`);
  for (const name of names) {
    const cells = sizes.map((size) => {
      const r = results.find((x) => x.size === size && x.name === name)!;
      return `${ms(r.medianMs)} (${ms(r.maxMs)})`;
    });
    console.log(`| ${name} | ${cells.join(" | ")} |`);
  }
  if (plans.length === 0) return;
  console.log("\n# Plans\n");
  for (const size of sizes) {
    for (const name of names) {
      const forScenario = plans.filter((p) => p.size === size && p.name === name);
      if (forScenario.length === 0) continue;
      console.log(`## ${name} at ${size.toLocaleString("en")} records\n`);
      for (const p of forScenario) {
        console.log(`\`\`\`\n-- ${ms(p.durationMs)} ms\n${p.plan.trim()}\n\`\`\`\n`);
      }
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
