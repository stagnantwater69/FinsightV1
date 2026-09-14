import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

/**
 * GET /records/receipts/provider-consent/:businessProfileId carries a `mode`
 * so a client can hide the consent card when consent is granted by operator
 * policy. `.strict()` so an added, removed, or renamed field fails here.
 */

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
import { resetRateLimits } from "../../src/middleware/rateLimit.middleware";
import { disconnectDb, makeOwnerWithProfile, resetDb } from "../setup/testDb";

const AUTH = ["Authorization", "Bearer valid-token"] as const;

const consentReferenceSchema = z
  .object({ reference: z.string().regex(/^consent:\d+$/), grantedAt: z.string(), revokedAt: z.null() })
  .strict();

const consentStateSchema = z
  .object({
    available: z.boolean(),
    mode: z.enum(["explicit", "automatic"]),
    provider: z
      .object({
        key: z.enum(["gemini", "veryfi"]),
        label: z.string(),
        version: z.string(),
        region: z.string(),
        policyVersion: z.string(),
        purpose: z.literal("RECEIPT_EXTRACTION"),
        dataClasses: z.tuple([z.literal("RECEIPT_IMAGE"), z.literal("DERIVED_RECEIPT_IMAGE")]),
        retentionHours: z.number().int(),
        trainingAllowed: z.literal(false),
        revocable: z.literal(true),
      })
      .strict()
      .nullable(),
    consent: consentReferenceSchema.nullable(),
    activeConsents: z.array(z.object({ reference: z.string(), provider: z.string() }).passthrough()),
    policyBlocked: z.boolean(),
  })
  .strict();

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
  vi.stubEnv("GOOGLE_GEMINI_API_KEY", "mocked-provider-key");
}

let owner: Awaited<ReturnType<typeof makeOwnerWithProfile>>;
let url: string;

beforeEach(async () => {
  vi.unstubAllEnvs();
  enableMockedGeminiProvider();
  await resetDb();
  resetRateLimits();
  owner = await makeOwnerWithProfile();
  authUserId.value = owner.user.authId;
  url = `/api/v1/records/receipts/provider-consent/${owner.profile.id}`;
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await disconnectDb();
});

describe("provider consent mode contract", () => {
  it("reports explicit mode by default and on unknown values", async () => {
    const absent = await request(app).get(url).set(...AUTH);
    expect(absent.status).toBe(200);
    expect(consentStateSchema.parse(absent.body)).toMatchObject({
      available: true,
      mode: "explicit",
      consent: null,
      policyBlocked: false,
    });

    vi.stubEnv("RECEIPT_PROVIDER_CONSENT_MODE", "AUTOMATIC");
    const unknown = await request(app).get(url).set(...AUTH);
    expect(consentStateSchema.parse(unknown.body).mode).toBe("explicit");
  });

  it("reports automatic mode on GET, PUT, and DELETE without dropping any existing field", async () => {
    vi.stubEnv("RECEIPT_PROVIDER_CONSENT_MODE", "automatic");
    const state = await request(app).get(url).set(...AUTH);
    expect(state.status).toBe(200);
    expect(consentStateSchema.parse(state.body)).toMatchObject({
      available: true,
      mode: "automatic",
      consent: null,
      policyBlocked: false,
    });

    const granted = await request(app).put(url).set(...AUTH).send({
      provider: "gemini",
      policyVersion: "receipt-provider-policy-v1",
      purpose: "RECEIPT_EXTRACTION",
      dataClasses: ["RECEIPT_IMAGE", "DERIVED_RECEIPT_IMAGE"],
      region: "global",
      retentionHours: 0,
      trainingAllowed: false,
    });
    expect(granted.status).toBe(200);
    expect(consentStateSchema.parse(granted.body).mode).toBe("automatic");
    expect(granted.body.consent).not.toBeNull();
    expect(granted.body.policyBlocked).toBe(false);

    const revoked = await request(app).delete(url).set(...AUTH);
    expect(revoked.status).toBe(200);
    expect(consentStateSchema.parse(revoked.body)).toMatchObject({
      mode: "automatic",
      consent: null,
      activeConsents: [],
      policyBlocked: true,
    });

    // The same revoked state reads as not blocked once the operator turns automatic mode off.
    vi.stubEnv("RECEIPT_PROVIDER_CONSENT_MODE", "explicit");
    const explicitAfterRevoke = await request(app).get(url).set(...AUTH);
    expect(consentStateSchema.parse(explicitAfterRevoke.body).policyBlocked).toBe(false);
  });

  it("reports the mode even when the provider is not available", async () => {
    vi.stubEnv("RECEIPT_PROVIDER_CONSENT_MODE", "automatic");
    vi.stubEnv("RECEIPT_PROVIDER_KILL_SWITCH", "true");
    const state = await request(app).get(url).set(...AUTH);
    expect(state.status).toBe(200);
    expect(consentStateSchema.parse(state.body)).toEqual({
      available: false,
      mode: "automatic",
      provider: null,
      consent: null,
      activeConsents: [],
      policyBlocked: false,
    });
  });
});
