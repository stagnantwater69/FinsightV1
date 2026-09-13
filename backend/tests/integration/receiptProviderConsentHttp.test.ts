import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const { authUserId } = vi.hoisted(() => ({ authUserId: { value: "" } }));
vi.mock("../../src/config/supabase", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/config/supabase")>();
  return {
    ...actual,
    supabaseAdmin: {
      auth: {
        getUser: async (token: string) =>
          token === "valid-token"
            ? { data: { user: { id: authUserId.value } }, error: null }
            : { data: { user: null }, error: new Error("bad token") },
      },
    },
  };
});

import request from "supertest";
import { app } from "../../src/app";
import { prisma } from "../../src/config/prisma";
import { resetRateLimits } from "../../src/middleware/rateLimit.middleware";
import { disconnectDb, makeOwnerWithProfile, resetDb } from "../setup/testDb";

const AUTH = ["Authorization", "Bearer valid-token"] as const;
let owner: Awaited<ReturnType<typeof makeOwnerWithProfile>>;

function enableMockedGeminiProvider() {
  vi.stubEnv("RECEIPT_PROVIDER_DISPATCH_ENABLED", "true");
  vi.stubEnv("RECEIPT_PROVIDER_KILL_SWITCH", "false");
  vi.stubEnv("RECEIPT_PROVIDER_DATA_TERMS_APPROVED", "true");
  vi.stubEnv("RECEIPT_PROVIDER", "gemini");
  vi.stubEnv("RECEIPT_PROVIDER_VERSION", "gemini-3.5-flash-lite");
  vi.stubEnv("RECEIPT_PROVIDER_REGION", "global");
  vi.stubEnv("RECEIPT_PROVIDER_RETENTION_HOURS", "0");
  vi.stubEnv("RECEIPT_PROVIDER_ROUTING_CALIBRATED", "true");
  vi.stubEnv("RECEIPT_PROVIDER_CALIBRATION_VERSION", "routing-v1");
  vi.stubEnv("RECEIPT_PROVIDER_MONTHLY_UNIT_LIMIT", "10");
  vi.stubEnv("RECEIPT_PROVIDER_BUSINESS_MONTHLY_UNIT_LIMIT", "5");
  vi.stubEnv("GOOGLE_GEMINI_API_KEY", "mocked-provider-key");
}

function consentTerms() {
  return {
    provider: "gemini",
    policyVersion: "receipt-provider-policy-v1",
    purpose: "RECEIPT_EXTRACTION",
    dataClasses: ["RECEIPT_IMAGE", "DERIVED_RECEIPT_IMAGE"],
    region: "global",
    retentionHours: 0,
    trainingAllowed: false,
  };
}

beforeEach(async () => {
  vi.unstubAllEnvs();
  enableMockedGeminiProvider();
  await resetDb();
  resetRateLimits();
  owner = await makeOwnerWithProfile();
  authUserId.value = owner.user.authId;
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await disconnectDb();
});

describe("mocked provider consent HTTP contract", () => {
  it("advertises exact terms only when the server-side provider gate is operational", async () => {
    const response = await request(app)
      .get(`/api/v1/records/receipts/provider-consent/${owner.profile.id}`)
      .set(...AUTH);

    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).toEqual({
      available: true,
      provider: {
        key: "gemini",
        label: "Google Gemini",
        version: "gemini-3.5-flash-lite",
        region: "global",
        policyVersion: "receipt-provider-policy-v1",
        purpose: "RECEIPT_EXTRACTION",
        dataClasses: ["RECEIPT_IMAGE", "DERIVED_RECEIPT_IMAGE"],
        retentionHours: 0,
        trainingAllowed: false,
        revocable: true,
      },
      consent: null,
      activeConsents: [],
    });
    expect(JSON.stringify(response.body)).not.toContain("mocked-provider-key");
  });

  it("grants exact terms idempotently and rejects a stale or reordered grant", async () => {
    const url = `/api/v1/records/receipts/provider-consent/${owner.profile.id}`;
    const first = await request(app).put(url).set(...AUTH).send(consentTerms());
    const second = await request(app).put(url).set(...AUTH).send(consentTerms());

    expect(first.status).toBe(200);
    expect(first.body.consent.reference).toMatch(/^consent:\d+$/);
    expect(second.status).toBe(200);
    expect(second.body.consent.reference).toBe(first.body.consent.reference);
    expect(await prisma.externalProcessingConsent.count()).toBe(1);

    const reordered = await request(app).put(url).set(...AUTH).send({
      ...consentTerms(),
      dataClasses: ["DERIVED_RECEIPT_IMAGE", "RECEIPT_IMAGE"],
    });
    const changed = await request(app).put(url).set(...AUTH).send({
      ...consentTerms(),
      retentionHours: 1,
    });
    expect(reordered.status).toBe(409);
    expect(changed.status).toBe(409);
    expect(await prisma.externalProcessingConsent.count()).toBe(1);
  });

  it("revokes active consent and leaves an auditable closed grant", async () => {
    const url = `/api/v1/records/receipts/provider-consent/${owner.profile.id}`;
    await request(app).put(url).set(...AUTH).send(consentTerms());

    const revoked = await request(app).delete(url).set(...AUTH);
    expect(revoked.status).toBe(200);
    expect(revoked.body).toMatchObject({ available: true, consent: null, activeConsents: [] });
    const stored = await prisma.externalProcessingConsent.findFirstOrThrow();
    expect(stored.revokedAt).toBeInstanceOf(Date);
  });

  it("keeps a revoke-only view when provider dispatch is disabled", async () => {
    const url = `/api/v1/records/receipts/provider-consent/${owner.profile.id}`;
    await request(app).put(url).set(...AUTH).send(consentTerms());
    vi.stubEnv("RECEIPT_PROVIDER_KILL_SWITCH", "true");

    const state = await request(app).get(url).set(...AUTH);
    expect(state.status).toBe(200);
    expect(state.body.available).toBe(false);
    expect(state.body.provider).toBeNull();
    expect(state.body.consent).toBeNull();
    expect(state.body.activeConsents).toHaveLength(1);
    expect(state.body.activeConsents[0]).toMatchObject({ provider: "gemini", revocable: true });

    const revoked = await request(app).delete(url).set(...AUTH);
    expect(revoked.status).toBe(200);
    expect(revoked.body).toEqual({ available: false, provider: null, consent: null, activeConsents: [] });
  });

  it("does not reveal, grant, or revoke another owner's consent", async () => {
    const other = await makeOwnerWithProfile();
    const otherUrl = `/api/v1/records/receipts/provider-consent/${other.profile.id}`;
    authUserId.value = other.user.authId;
    expect((await request(app).put(otherUrl).set(...AUTH).send(consentTerms())).status).toBe(200);
    authUserId.value = owner.user.authId;

    expect((await request(app).get(otherUrl).set(...AUTH)).status).toBe(404);
    expect((await request(app).put(otherUrl).set(...AUTH).send(consentTerms())).status).toBe(404);
    expect((await request(app).delete(otherUrl).set(...AUTH)).status).toBe(404);
    expect(await prisma.externalProcessingConsent.count({ where: { businessProfileId: other.profile.id, revokedAt: null } })).toBe(1);
  });

  it("does not advertise or accept a grant when data terms approval is absent", async () => {
    vi.stubEnv("RECEIPT_PROVIDER_DATA_TERMS_APPROVED", "false");
    const url = `/api/v1/records/receipts/provider-consent/${owner.profile.id}`;

    const state = await request(app).get(url).set(...AUTH);
    const grant = await request(app).put(url).set(...AUTH).send(consentTerms());
    expect(state.status).toBe(200);
    expect(state.body).toEqual({ available: false, provider: null, consent: null, activeConsents: [] });
    expect(grant.status).toBe(404);
    expect(await prisma.externalProcessingConsent.count()).toBe(0);
  });

  it("rejects malformed identifiers and unknown consent fields without storing a grant", async () => {
    expect((await request(app).get("/api/v1/records/receipts/provider-consent/not-a-number").set(...AUTH)).status).toBe(400);
    const response = await request(app)
      .put(`/api/v1/records/receipts/provider-consent/${owner.profile.id}`)
      .set(...AUTH)
      .send({ ...consentTerms(), providerApiKey: "must-not-be-accepted" });
    expect(response.status).toBe(400);
    expect(await prisma.externalProcessingConsent.count()).toBe(0);
  });
});
