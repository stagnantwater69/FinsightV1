import { afterAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../../src/app";
import { prisma } from "../../src/config/prisma";
import { disconnectDb, makeOwnerWithProfile, resetDb } from "../setup/testDb";

beforeEach(resetDb);
afterAll(disconnectDb);

describe("CSV operational readiness", () => {
  it("separates claimable queue wait from in-flight processing age", async () => {
    const { profile } = await makeOwnerWithProfile();
    const now = Date.now();
    await prisma.cSVImportBatch.createMany({
      data: [
        {
          businessProfileId: profile.id,
          title: "waiting",
          uploadDate: new Date(now),
          processingStatus: "PENDING",
          nextAttemptAt: new Date(now - 30_000),
          createdAt: new Date(now - 20_000),
        },
        {
          businessProfileId: profile.id,
          title: "backoff",
          uploadDate: new Date(now),
          processingStatus: "PENDING",
          nextAttemptAt: new Date(now + 60_000),
          createdAt: new Date(now - 40_000),
        },
        {
          businessProfileId: profile.id,
          title: "working",
          uploadDate: new Date(now),
          processingStatus: "PROCESSING",
          createdAt: new Date(now - 25_000),
        },
      ],
    });

    const response = await request(app).get("/api/v1/health/ready");

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      queuedCsvImports: 3,
      pendingCsvImports: 1,
      processingCsvImports: 1,
    });
    expect(response.body.oldestPendingCsvImportAgeSeconds).toBeGreaterThanOrEqual(19);
    expect(response.body.oldestProcessingCsvImportAgeSeconds).toBeGreaterThanOrEqual(24);
  });
});
