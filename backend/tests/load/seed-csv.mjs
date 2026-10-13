import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const count = Number(process.env.BENCH_USER_COUNT ?? 5);
const offset = Number(process.env.BENCH_USER_OFFSET ?? 0);

if (!Number.isInteger(count) || count < 1 || count > 20) {
  throw new Error("BENCH_USER_COUNT must be an integer from 1 to 20");
}
if (!Number.isInteger(offset) || offset < 0 || offset > 999_000) {
  throw new Error("BENCH_USER_OFFSET must be an integer from 0 to 999000");
}

const contexts = [];

try {
  for (let index = 1; index <= count; index += 1) {
    const number = offset + index;
    const authId = `00000000-0000-4000-8000-${String(900_000 + number).padStart(12, "0")}`;
    const user = await prisma.user.create({
      data: {
        authId,
        firstName: "Csv",
        lastName: `Bench${number}`,
        email: `csv-bench-${number}@loadtest.invalid`,
      },
    });
    const profile = await prisma.businessProfile.create({
      data: {
        userId: user.id,
        name: `CSV benchmark ${number}`,
        type: "Retail",
        availableFunds: 50_000,
        expectedMonthlyExpenses: 30_000,
        operatingDays: 26,
        timezone: "Asia/Manila",
      },
    });
    await prisma.expenseCategory.create({
      data: { businessProfileId: profile.id, name: "Inventory" },
    });
    contexts.push({ profileId: profile.id, token: authId });
  }
  process.stdout.write(`${JSON.stringify({ contexts })}\n`);
} finally {
  await prisma.$disconnect();
}
