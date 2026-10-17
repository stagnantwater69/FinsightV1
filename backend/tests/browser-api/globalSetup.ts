import { PrismaClient } from "@prisma/client";
import migrate from "../setup/globalSetup";
import { guardBrowserFixture } from "./guard";

export default async function globalSetup() {
  guardBrowserFixture(process.env);
  const db = new PrismaClient({ datasources: { db: { url: process.env.DIRECT_URL! } } });
  try {
    const identity = await db.$queryRaw<{ name: string }[]>`SELECT current_database() AS name`;
    if (identity[0]?.name !== "finsight_test") throw new Error("Local browser fixture database identity is not finsight_test");
    await db.$executeRaw`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'postgres') THEN CREATE ROLE postgres NOLOGIN; END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
      END $$
    `;
  } finally { await db.$disconnect(); }
  await migrate();
}
