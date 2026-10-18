import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
const authUserId = vi.hoisted(() => ({ value: "" }));
vi.mock("../../src/config/supabase", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/config/supabase")>();
  return { ...actual, supabaseAdmin: { auth: { getUser: async () => ({ data: { user: { id: authUserId.value } }, error: null }) } } };
});

import request from "supertest";
import { app } from "../../src/app";
import { prisma } from "../../src/config/prisma";
import * as notifications from "../../src/services/notification.service";
import { getDashboardSummary } from "../../src/services/dashboard.service";
import { disconnectDb, makeOwnerWithProfile, resetDb } from "../setup/testDb";

/**
 * The unread badge is a total, not a count of whatever list a client holds.
 * The dashboard carries ten alerts, so a badge counted from it stopped at ten.
 */

let owner: Awaited<ReturnType<typeof makeOwnerWithProfile>>;

beforeEach(async () => {
  await resetDb();
  owner = await makeOwnerWithProfile({ name: "Badge Store" });
  authUserId.value = owner.user.authId;
});

afterAll(disconnectDb);

async function addAlerts(count: number, businessProfileId = owner.profile.id) {
  for (let index = 0; index < count; index++) {
    await notifications.createNotification(owner.user.id, businessProfileId, "Needs Review", `Alert ${index + 1}`);
  }
}

describe("unread notification count", () => {
  it("counts every unread alert, past the ten the dashboard carries", async () => {
    await addAlerts(14);
    const [first] = await notifications.listNotifications(owner.user.id, owner.profile.id, 1);
    await notifications.markNotificationRead(owner.user.id, first!.id);

    const summary = await getDashboardSummary(owner.user.id, owner.profile.id, { kind: "all" });

    expect(summary.alerts).toHaveLength(10);
    expect(summary.unreadAlertCount).toBe(13);
    expect(await notifications.countUnreadNotifications(owner.user.id, owner.profile.id)).toBe(13);
  });

  it("sends the total past the 500-row list on the bell's request", async () => {
    await prisma.notification.createMany({
      data: Array.from({ length: 503 }, (_, index) => ({
        userId: owner.user.id, businessProfileId: owner.profile.id, type: "Needs Review", message: `Alert ${index + 1}`,
      })),
    });

    const response = await request(app).get("/api/v1/notifications")
      .set("Authorization", "Bearer synthetic-token").set("Origin", "http://localhost:5173")
      .query({ businessProfileId: owner.profile.id });

    expect(response.status).toBe(200);
    expect(response.body).toHaveLength(500);
    expect(response.headers["x-unread-count"]).toBe("503");
    expect(response.headers["access-control-expose-headers"]).toContain("X-Unread-Count");
  });

  it("reaches zero after mark-all-read", async () => {
    await addAlerts(3);
    await notifications.markAllNotificationsRead(owner.user.id, owner.profile.id);

    expect(await notifications.countUnreadNotifications(owner.user.id, owner.profile.id)).toBe(0);
  });

  it("counts only the named business", async () => {
    const second = await prisma.businessProfile.create({
      data: {
        userId: owner.user.id,
        name: "Second Store",
        type: "Retail",
        availableFunds: 0,
        expectedMonthlyExpenses: 0,
        operatingDays: 20,
      },
    });
    await addAlerts(2);
    await addAlerts(5, second.id);

    expect(await notifications.countUnreadNotifications(owner.user.id, owner.profile.id)).toBe(2);
    expect(await notifications.countUnreadNotifications(owner.user.id, second.id)).toBe(5);
    expect(await notifications.countUnreadNotifications(owner.user.id)).toBe(7);
  });
});
