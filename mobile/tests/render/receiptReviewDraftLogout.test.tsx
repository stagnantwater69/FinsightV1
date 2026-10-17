import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react-native";
import { Text } from "react-native";
import * as SecureStore from "expo-secure-store";

const get = vi.fn();
const post = vi.fn();
const profile = { id: 7, firstName: "Ana", middleName: null, lastName: "Reyes", email: "ana@example.com", phoneNumber: null, status: "ACTIVE", avatarUrl: null, createdAt: "2026-01-01T00:00:00.000Z" };

vi.mock("../../src/lib/api", () => ({
  api: { get, post, patch: vi.fn() },
  errorMessage: (error: Error) => error.message,
  setSessionEndedHandler: vi.fn(),
  invalidateApiSessionRequests: vi.fn(),
}));
vi.mock("../../src/lib/supabase", () => ({
  supabase: {
    auth: {
      getSession: vi.fn(async () => ({ data: { session: { access_token: "token" } } })),
      onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
      setSession: vi.fn(),
      signOut: vi.fn(async () => ({ error: null })),
    },
  },
}));
vi.mock("../../src/lib/receiptScannerCache", () => ({ clearReceiptScannerCache: vi.fn(async () => 0) }));

const { AuthProvider, useAuth } = await import("../../src/context/AuthContext");
const { readReceiptReviewDraft, saveReceiptReviewDraft } = await import("../../src/lib/receiptReviewDraft");
const { clearServerStateCache } = await import("../../src/lib/serverStateCache");

const edits = { date: "2026-09-01", description: "Corrected", vendor: "Supplier", amount: "260.00", categoryId: 10, itemCategories: {}, addedItems: [], plan: null, gapCategoryId: null, editingItem: null };
let auth!: ReturnType<typeof useAuth>;
function Probe() {
  auth = useAuth();
  return <Text>{auth.profile ? `Signed in as ${auth.profile.id}` : "Signed out"}</Text>;
}

beforeEach(() => {
  (SecureStore as unknown as { __reset: () => void }).__reset();
  clearServerStateCache();
  get.mockReset();
  post.mockReset();
  get.mockImplementation(async (path: string) => (path === "/auth/me" ? profile : []));
  post.mockResolvedValue({});
});

afterEach(async () => {
  await cleanup();
  clearServerStateCache();
});

describe("receipt review drafts on sign-out", () => {
  it("removes the signed-out account's drafts and keeps another account's", async () => {
    await saveReceiptReviewDraft({ ownerId: 7, businessProfileId: 1, scanId: 41 }, edits);
    await saveReceiptReviewDraft({ ownerId: 7, businessProfileId: 2, scanId: 60 }, edits);
    await saveReceiptReviewDraft({ ownerId: 8, businessProfileId: 1, scanId: 41 }, edits);
    const q = await render(<AuthProvider><Probe /></AuthProvider>);
    await waitFor(() => expect(q.getByText("Signed in as 7")).toBeTruthy());
    expect(await readReceiptReviewDraft({ ownerId: 7, businessProfileId: 1, scanId: 41 })).not.toBeNull();

    await act(async () => { await auth.logout(); });
    await waitFor(() => expect(q.getByText("Signed out")).toBeTruthy());

    await waitFor(async () => expect(await readReceiptReviewDraft({ ownerId: 7, businessProfileId: 1, scanId: 41 })).toBeNull());
    expect(await readReceiptReviewDraft({ ownerId: 7, businessProfileId: 2, scanId: 60 })).toBeNull();
    expect(await readReceiptReviewDraft({ ownerId: 8, businessProfileId: 1, scanId: 41 })).not.toBeNull();
  });
});
