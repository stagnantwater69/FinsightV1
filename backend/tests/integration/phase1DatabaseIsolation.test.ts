import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../src/config/prisma";
import { disconnectDb, makeOwnerWithProfile, resetDb } from "../setup/testDb";

const PHASE1_TABLES = [
  "ExternalProcessingConsent",
  "ExternalProviderBudget",
  "ExternalProviderDispatch",
  "ReceiptPurgeJob",
] as const;

beforeEach(resetDb);
afterAll(disconnectDb);

describe("Phase 1 database tenant and privilege isolation", () => {
  it("has RLS enabled, no client policy, and no PUBLIC table or sequence grants", async () => {
    const rows = await prisma.$queryRaw<{
      relname: string;
      relrowsecurity: boolean;
      public_privileges: bigint;
      policies: bigint;
    }[]>`
      SELECT
        c.relname,
        c.relrowsecurity,
        (
          SELECT COUNT(*)
          FROM aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) acl
          WHERE acl.grantee = 0
        ) AS public_privileges,
        (
          SELECT COUNT(*)
          FROM pg_policy p
          WHERE p.polrelid = c.oid
        ) AS policies
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relname IN ('ExternalProcessingConsent', 'ExternalProviderBudget', 'ExternalProviderDispatch', 'ReceiptPurgeJob')
      ORDER BY c.relname
    `;

    expect(rows.map((row) => row.relname)).toEqual([...PHASE1_TABLES].sort());
    for (const row of rows) {
      expect(row.relrowsecurity, row.relname).toBe(true);
      expect(Number(row.public_privileges), row.relname).toBe(0);
      expect(Number(row.policies), row.relname).toBe(0);
    }

    const publicSequencePrivileges = await prisma.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*) AS count
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault('S', c.relowner))) acl
      WHERE n.nspname = 'public'
        AND c.relkind = 'S'
        AND c.relname IN (
          'ExternalProcessingConsent_ExternalProcessingConsent_ID_seq',
          'ExternalProviderBudget_ExternalProviderBudget_ID_seq',
          'ExternalProviderDispatch_ExternalProviderDispatch_ID_seq',
          'ReceiptPurgeJob_ReceiptPurgeJob_ID_seq'
        )
        AND acl.grantee = 0
    `;
    expect(Number(publicSequencePrivileges[0]!.count)).toBe(0);
  });

  it("rejects consent whose actor does not own the target business", async () => {
    const owner = await makeOwnerWithProfile();
    const other = await makeOwnerWithProfile();

    await expect(prisma.externalProcessingConsent.create({
      data: {
        businessProfileId: owner.profile.id,
        actorUserId: other.user.id,
        provider: "gemini",
        policyVersion: "receipt-provider-policy-v1",
        purpose: "RECEIPT_EXTRACTION",
        allowedDataClasses: ["RECEIPT_IMAGE"],
        processingRegion: "global",
        providerRetentionHours: 0,
      },
    })).rejects.toMatchObject({ code: "P2003" });
    expect(await prisma.externalProcessingConsent.count()).toBe(0);
  });

  it("permits only one unrevoked provider consent per business under a race", async () => {
    const owner = await makeOwnerWithProfile();
    const create = () => prisma.externalProcessingConsent.create({
      data: {
        businessProfileId: owner.profile.id,
        actorUserId: owner.user.id,
        provider: "gemini",
        policyVersion: "receipt-provider-policy-v1",
        purpose: "RECEIPT_EXTRACTION" as const,
        allowedDataClasses: ["RECEIPT_IMAGE" as const],
        processingRegion: "global",
        providerRetentionHours: 0,
      },
    });

    const results = await Promise.allSettled([create(), create()]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(await prisma.externalProcessingConsent.count({ where: { revokedAt: null } })).toBe(1);
  });

  it("rejects budget rows that exceed their hard monthly limit", async () => {
    const cycleStart = new Date(Date.UTC(2026, 8, 1));
    const cycleEnd = new Date(Date.UTC(2026, 9, 1));

    await expect(prisma.externalProviderBudget.create({
      data: {
        scope: "RESOURCE",
        provider: "gemini",
        unitType: "DOCUMENT",
        cycleStart,
        cycleEnd,
        limitUnits: 1,
        reservedUnits: 2,
      },
    })).rejects.toThrow(/ExternalProviderBudget_units_check|check constraint/);
    expect(await prisma.externalProviderBudget.count()).toBe(0);
  });

  it("rejects a purge target whose receipt belongs to another business", async () => {
    const owner = await makeOwnerWithProfile();
    const other = await makeOwnerWithProfile();
    const otherScan = await prisma.receiptScan.create({
      data: {
        businessProfileId: other.profile.id,
        imageFile: `${other.profile.id}/receipt.jpg`,
      },
    });

    await expect(prisma.receiptPurgeJob.create({
      data: {
        businessProfileId: owner.profile.id,
        receiptScanId: otherScan.id,
        receiptScanBusinessProfileId: owner.profile.id,
        requestKeyHash: "a".repeat(64),
        targetReferenceHash: "b".repeat(64),
        reason: "OWNER_REQUEST",
        mode: "DELETE_SCAN",
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    })).rejects.toMatchObject({ code: "P2003" });
    expect(await prisma.receiptPurgeJob.count()).toBe(0);
  });
});
