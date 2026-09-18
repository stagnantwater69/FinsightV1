/**
 * Seeds synthetic load-test data into the throwaway database.
 *
 * Two population shapes, because they answer different questions:
 *   - the many-users shape (USERS): concurrency, connection pool, auth cost
 *   - the fat-profile shape (FAT_RECORDS on user 1): whether reads stay bounded
 *     as one owner's history grows, which is where unbounded findMany hurts
 *
 * Every value is synthetic. No real receipt, vendor or owner data is used.
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const USERS = Number(process.env.SEED_USERS ?? 60);
const RECORDS_PER_USER = Number(process.env.SEED_RECORDS ?? 400);
const FAT_RECORDS = Number(process.env.SEED_FAT_RECORDS ?? 50_000);

const authId = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const CATEGORIES = ["Inventory", "Utilities", "Rent", "Transport", "Supplies", "Wages", "Repairs", "Permits"];
const VENDORS = ["Divisoria Wholesale", "Meralco", "Maynilad", "Jollibee Supplier", "Puregold", "SM Supplies"];

function amountFor(i) {
  // A long right tail, so anomaly detection and the large-expense flag have
  // something real to chew on rather than a flat distribution.
  const base = 150 + ((i * 37) % 2500);
  return i % 97 === 0 ? base * 12 : base;
}

async function main() {
  const started = Date.now();
  console.log(`seeding ${USERS} users x ${RECORDS_PER_USER} records, plus ${FAT_RECORDS} on user 1`);

  for (let u = 1; u <= USERS; u += 1) {
    const user = await prisma.user.create({
      data: {
        authId: authId(u),
        firstName: `Load${u}`,
        lastName: "Tester",
        email: `u${String(u).padStart(12, "0")}@loadtest.invalid`,
        status: "ACTIVE",
      },
    });

    const profile = await prisma.businessProfile.create({
      data: {
        userId: user.id,
        name: `Load Test Sari-Sari ${u}`,
        type: "Retail",
        availableFunds: 50_000,
        expectedMonthlyExpenses: 30_000,
        operatingDays: 26,
        timezone: "Asia/Manila",
      },
    });

    const categories = await Promise.all(
      CATEGORIES.map((name) =>
        prisma.expenseCategory.create({ data: { businessProfileId: profile.id, name } }),
      ),
    );

    const count = u === 1 ? FAT_RECORDS : RECORDS_PER_USER;
    const rows = [];
    for (let i = 0; i < count; i += 1) {
      const day = (i % 364) + 1;
      const date = new Date(Date.UTC(2026, 0, 1));
      date.setUTCDate(date.getUTCDate() + day);
      rows.push({
        businessProfileId: profile.id,
        categoryId: categories[i % categories.length].id,
        date,
        description: `Synthetic expense ${i} for load testing, restock and sundries`,
        vendor: VENDORS[i % VENDORS.length],
        amount: amountFor(i),
        source: "MANUAL_ENTRY",
        reviewStatus: "OK",
        duplicateStatus: "Not a Duplicate",
      });
    }
    // Chunked: one createMany with 50k rows is a single huge statement.
    for (let i = 0; i < rows.length; i += 5_000) {
      await prisma.expenseRecord.createMany({ data: rows.slice(i, i + 5_000) });
    }

    const sales = [];
    for (let i = 0; i < Math.min(count, 2_000); i += 1) {
      const date = new Date(Date.UTC(2026, 0, 1));
      date.setUTCDate(date.getUTCDate() + ((i % 364) + 1));
      sales.push({
        businessProfileId: profile.id,
        date,
        description: `Synthetic sales reference ${i}`,
        amount: 400 + ((i * 53) % 4000),
        source: "MANUAL_ENTRY",
      });
    }
    for (let i = 0; i < sales.length; i += 5_000) {
      await prisma.salesReferenceRecord.createMany({ data: sales.slice(i, i + 5_000) });
    }

    if (u % 10 === 0 || u === 1) console.log(`  user ${u}: ${count} expenses, ${sales.length} sales`);
  }

  const totals = {
    users: await prisma.user.count(),
    profiles: await prisma.businessProfile.count(),
    expenses: await prisma.expenseRecord.count(),
    sales: await prisma.salesReferenceRecord.count(),
  };
  console.log(`done in ${Math.round((Date.now() - started) / 1000)}s`, totals);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
