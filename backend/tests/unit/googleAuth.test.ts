import { AccountStatus, Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(), findUnique: vi.fn(), create: vi.fn(), transition: vi.fn(), count: vi.fn(),
}));

vi.mock("../../src/config/supabase", () => ({
  supabaseAdmin: { auth: { getUser: mocks.getUser } },
  createAnonAuthClient: vi.fn(), createPasswordAuthClient: vi.fn(),
}));
vi.mock("../../src/config/prisma", () => ({
  prisma: { user: { findUnique: mocks.findUnique, create: mocks.create }, businessProfile: { count: mocks.count } },
}));
vi.mock("../../src/lib/securityLog", () => ({ securityEvent: vi.fn() }));
vi.mock("../../src/services/storage.service", () => ({
  PUBLIC_IMAGE_UPLOAD_TRANSACTION_TIMEOUT_MS: 30_000,
}));
vi.mock("../../src/services/accountLifecycle.service", () => ({
  isUsable: (status: string) => status === "ACTIVE",
  statusRefusal: (status: string) => `Account ${status}`,
  transition: mocks.transition,
}));

const { loginWithGoogle } = await import("../../src/services/auth.service");

const googleIdentity = {
  id: "google-identity", provider: "google",
  identity_data: { email: "owner@shop.ph", email_verified: true },
};
const providerUser = {
  id: "auth-google", email: "owner@shop.ph", email_confirmed_at: "2026-10-10T00:00:00Z",
  identities: [googleIdentity], user_metadata: { full_name: "Ana Reyes" },
};
const profile = {
  id: 7, authId: "auth-google", email: "owner@shop.ph", firstName: "Ana", middleName: null,
  lastName: "Reyes", phoneNumber: null, status: AccountStatus.ACTIVE, avatarUrl: null,
  createdAt: new Date("2026-01-01"),
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getUser.mockResolvedValue({ data: { user: providerUser }, error: null });
  mocks.findUnique.mockResolvedValue(profile);
  mocks.create.mockResolvedValue(profile);
  mocks.count.mockResolvedValue(0);
  mocks.transition.mockImplementation(async (user: typeof profile, status: AccountStatus) => {
    user.status = status;
    return user;
  });
});

describe("Google identity exchange", () => {
  it("verifies the bearer with Supabase before reading any application profile", async () => {
    const result = await loginWithGoogle("google-bearer");
    expect(mocks.getUser).toHaveBeenCalledWith("google-bearer");
    expect(mocks.getUser.mock.invocationCallOrder[0]).toBeLessThan(mocks.findUnique.mock.invocationCallOrder[0]);
    expect(mocks.findUnique).toHaveBeenCalledWith({ where: { authId: "auth-google" } });
    expect(result.profile.id).toBe(7);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("rejects a provider-refused token before accessing the database", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: { status: 401, message: "invalid" } });
    await expect(loginWithGoogle("invalid")).rejects.toMatchObject({ status: 401 });
    expect(mocks.findUnique).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it.each([
    ["editable provider metadata", { identities: [], user_metadata: { provider: "google", email_verified: true } }],
    ["another provider", { identities: [{ ...googleIdentity, provider: "github" }] }],
    ["unverified Google email", { identities: [{ ...googleIdentity, identity_data: { email: "owner@shop.ph", email_verified: false } }] }],
    ["a linked identity with a different email", { identities: [{ ...googleIdentity, identity_data: { email: "other@shop.ph", email_verified: true } }] }],
    ["an unconfirmed primary email", { email_confirmed_at: null }],
  ])("rejects %s without provisioning", async (_label, overrides) => {
    mocks.getUser.mockResolvedValue({ data: { user: { ...providerUser, ...overrides } }, error: null });
    await expect(loginWithGoogle("bearer")).rejects.toMatchObject({ status: 403 });
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.transition).not.toHaveBeenCalled();
  });

  it.each([AccountStatus.SUSPENDED, AccountStatus.DELETION_PENDING])("refuses an existing %s account", async status => {
    mocks.findUnique.mockResolvedValue({ ...profile, status });
    await expect(loginWithGoogle("bearer")).rejects.toMatchObject({ status: 403 });
    expect(mocks.transition).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("activates a pending account only after verified Google email proof", async () => {
    mocks.findUnique.mockResolvedValue({ ...profile, status: AccountStatus.PENDING_VERIFICATION });
    await loginWithGoogle("bearer");
    expect(mocks.transition).toHaveBeenCalledWith(
      expect.objectContaining({ authId: "auth-google" }), AccountStatus.ACTIVE, expect.any(Object),
    );
  });

  it("creates a new account under the verified auth ID", async () => {
    mocks.findUnique.mockResolvedValue(null);
    const result = await loginWithGoogle("bearer");
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ authId: "auth-google", email: "owner@shop.ph", status: AccountStatus.ACTIVE }),
    }));
    expect(result.needsOnboarding).toBe(true);
  });

  it("never merges an unrelated account merely because email matches", async () => {
    mocks.findUnique.mockImplementation(async ({ where }: { where: Record<string, string> }) =>
      where.authId ? null : { ...profile, authId: "another-owner" });
    await expect(loginWithGoogle("bearer")).rejects.toMatchObject({ status: 409 });
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.transition).not.toHaveBeenCalled();
  });

  it("accepts a concurrent callback that inserted the same identity before the email lookup", async () => {
    mocks.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(profile);
    const result = await loginWithGoogle("bearer");
    expect(result.profile.id).toBe(profile.id);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("does not adopt a raced unique-email collision belonging to another identity", async () => {
    mocks.findUnique.mockResolvedValue(null);
    mocks.create.mockRejectedValue(new Prisma.PrismaClientKnownRequestError("unique", { code: "P2002", clientVersion: "6" }));
    await expect(loginWithGoogle("bearer")).rejects.toMatchObject({ status: 409 });
    expect(mocks.transition).not.toHaveBeenCalled();
  });

  it("reports provider outages as unavailable rather than invalid credentials", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: { name: "AuthRetryableFetchError", status: 503 } });
    await expect(loginWithGoogle("bearer")).rejects.toMatchObject({ status: 503 });
    expect(mocks.findUnique).not.toHaveBeenCalled();
  });

  it("recovers a concurrent same-identity insert without creating a second owner", async () => {
    mocks.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValue(profile);
    mocks.create.mockRejectedValue(new Prisma.PrismaClientKnownRequestError("unique", { code: "P2002", clientVersion: "6" }));
    const result = await loginWithGoogle("bearer");
    expect(result.profile.id).toBe(profile.id);
    expect(mocks.create).toHaveBeenCalledTimes(1);
  });
});
