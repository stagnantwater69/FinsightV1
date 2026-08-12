import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../src/config/prisma";
import * as businessProfiles from "../../src/services/businessProfile.service";
import * as expenses from "../../src/services/expenseRecord.service";
import { disconnectDb, makeOwnerWithProfile, makeProfile, resetDb, utcDayString } from "../setup/testDb";

// Soft delete (archive), not hard delete.
//
// Every child relation cascades from BusinessProfile, so a real delete would
// destroy an owner's whole financial history for that business irreversibly.
// These tests exist mainly to prove that archiving does NOT do that.

let ctx: Awaited<ReturnType<typeof makeOwnerWithProfile>>;

beforeEach(async () => {
  await resetDb();
  ctx = await makeOwnerWithProfile({ name: "Main Store" });
});

afterAll(disconnectDb);

const notFound = { status: 404 };

describe("archiving", () => {
  it("sets archivedAt and reports the profile as archived", async () => {
    const before = await businessProfiles.getBusinessProfile(ctx.user.id, ctx.profile.id);
    expect(before.archivedAt).toBeNull();
    expect(before.isArchived).toBe(false);

    const after = await businessProfiles.archiveBusinessProfile(ctx.user.id, ctx.profile.id);
    expect(after.archivedAt).toBeInstanceOf(Date);
    expect(after.isArchived).toBe(true);
  });

  it("hides the profile from the default list", async () => {
    const second = await makeProfile(ctx.user.id, { name: "Second Store" });
    await businessProfiles.archiveBusinessProfile(ctx.user.id, ctx.profile.id);

    const active = await businessProfiles.listBusinessProfiles(ctx.user.id);
    expect(active.map((p) => p.id)).toEqual([second.id]);
  });

  it("still returns it when includeArchived is set", async () => {
    await businessProfiles.archiveBusinessProfile(ctx.user.id, ctx.profile.id);

    const all = await businessProfiles.listBusinessProfiles(ctx.user.id, true);
    expect(all.map((p) => p.id)).toContain(ctx.profile.id);
    expect(all.find((p) => p.id === ctx.profile.id)!.isArchived).toBe(true);
  });

  it("is still reachable by id, so it can be restored", async () => {
    await businessProfiles.archiveBusinessProfile(ctx.user.id, ctx.profile.id);
    const fetched = await businessProfiles.getBusinessProfile(ctx.user.id, ctx.profile.id);
    expect(fetched.id).toBe(ctx.profile.id);
  });

  it("is idempotent and does not move the timestamp on a repeat call", async () => {
    const first = await businessProfiles.archiveBusinessProfile(ctx.user.id, ctx.profile.id);
    const second = await businessProfiles.archiveBusinessProfile(ctx.user.id, ctx.profile.id);
    expect(second.archivedAt).toEqual(first.archivedAt);
  });

  // The whole point of soft delete.
  it("DESTROYS NOTHING — every record, category and AI turn survives", async () => {
    await expenses.createExpenseRecord(ctx.user.id, {
      businessProfileId: ctx.profile.id,
      categoryId: ctx.categories.Inventory!,
      date: utcDayString(0),
      description: "Should survive archiving",
      amount: 5000,
    });
    await prisma.aIInteraction.create({
      data: {
        userId: ctx.user.id,
        businessProfileId: ctx.profile.id,
        module: "Dashboard",
        question: "Should survive archiving",
        aiResponse: "Yes",
      },
    });

    const before = {
      profiles: await prisma.businessProfile.count({ where: { id: ctx.profile.id } }),
      expenses: await prisma.expenseRecord.count({ where: { businessProfileId: ctx.profile.id } }),
      categories: await prisma.expenseCategory.count({ where: { businessProfileId: ctx.profile.id } }),
      ai: await prisma.aIInteraction.count({ where: { businessProfileId: ctx.profile.id } }),
    };

    await businessProfiles.archiveBusinessProfile(ctx.user.id, ctx.profile.id);

    expect({
      profiles: await prisma.businessProfile.count({ where: { id: ctx.profile.id } }),
      expenses: await prisma.expenseRecord.count({ where: { businessProfileId: ctx.profile.id } }),
      categories: await prisma.expenseCategory.count({ where: { businessProfileId: ctx.profile.id } }),
      ai: await prisma.aIInteraction.count({ where: { businessProfileId: ctx.profile.id } }),
    }).toEqual(before);
  });
});

describe("restoring", () => {
  it("clears archivedAt and puts the profile back in the default list", async () => {
    await businessProfiles.archiveBusinessProfile(ctx.user.id, ctx.profile.id);
    expect(await businessProfiles.listBusinessProfiles(ctx.user.id)).toHaveLength(0);

    const restored = await businessProfiles.restoreBusinessProfile(ctx.user.id, ctx.profile.id);
    expect(restored.archivedAt).toBeNull();
    expect(restored.isArchived).toBe(false);
    expect((await businessProfiles.listBusinessProfiles(ctx.user.id)).map((p) => p.id)).toEqual([ctx.profile.id]);
  });

  it("brings the records back with it, untouched", async () => {
    await expenses.createExpenseRecord(ctx.user.id, {
      businessProfileId: ctx.profile.id,
      categoryId: ctx.categories.Inventory!,
      date: utcDayString(0),
      description: "Round trip",
      amount: 1234,
    });

    await businessProfiles.archiveBusinessProfile(ctx.user.id, ctx.profile.id);
    await businessProfiles.restoreBusinessProfile(ctx.user.id, ctx.profile.id);

    const records = await expenses.searchExpenseRecords(ctx.user.id, { businessProfileId: ctx.profile.id });
    expect(records).toHaveLength(1);
    expect(records[0]!.description).toBe("Round trip");
    expect(records[0]!.amount).toBe(1234);
  });

  it("is idempotent on an already-active profile", async () => {
    const restored = await businessProfiles.restoreBusinessProfile(ctx.user.id, ctx.profile.id);
    expect(restored.isArchived).toBe(false);
  });
});

describe("ownership", () => {
  it("cannot archive another owner's profile", async () => {
    const other = await makeOwnerWithProfile();
    await expect(
      businessProfiles.archiveBusinessProfile(ctx.user.id, other.profile.id)
    ).rejects.toMatchObject(notFound);

    const untouched = await prisma.businessProfile.findUniqueOrThrow({ where: { id: other.profile.id } });
    expect(untouched.archivedAt).toBeNull();
  });

  it("cannot restore another owner's archived profile", async () => {
    const other = await makeOwnerWithProfile();
    await businessProfiles.archiveBusinessProfile(other.user.id, other.profile.id);

    await expect(
      businessProfiles.restoreBusinessProfile(ctx.user.id, other.profile.id)
    ).rejects.toMatchObject(notFound);

    const stillArchived = await prisma.businessProfile.findUniqueOrThrow({ where: { id: other.profile.id } });
    expect(stillArchived.archivedAt).not.toBeNull();
  });

  it("returns 404 for a nonexistent profile, same as for a foreign one", async () => {
    await expect(businessProfiles.archiveBusinessProfile(ctx.user.id, 999999)).rejects.toMatchObject(notFound);
    await expect(businessProfiles.restoreBusinessProfile(ctx.user.id, 999999)).rejects.toMatchObject(notFound);
  });

  it("never shows another owner's archived profiles, even with includeArchived", async () => {
    const other = await makeOwnerWithProfile();
    await businessProfiles.archiveBusinessProfile(other.user.id, other.profile.id);

    const mine = await businessProfiles.listBusinessProfiles(ctx.user.id, true);
    expect(mine.map((p) => p.id)).not.toContain(other.profile.id);
  });
});
