import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Acceptance: "signed receipt links expire at ten minutes". The HTTP test
 * replaces storage.service wholesale, so on its own it only shows the
 * controller propagates whatever the module exports. This pins the real
 * constant and the TTL that actually reaches Supabase's createSignedUrl.
 */
const { createSignedUrl } = vi.hoisted(() => ({ createSignedUrl: vi.fn() }));

vi.mock("../../src/config/supabase", () => ({
  supabaseAdmin: { storage: { from: vi.fn(() => ({ createSignedUrl })) } },
}));
vi.mock("../../src/config/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import { supabaseAdmin } from "../../src/config/supabase";
import { RECEIPT_URL_TTL_SECONDS, signedReceiptImageUrl } from "../../src/services/storage.service";

describe("receipt signed-link TTL", () => {
  beforeEach(() => {
    createSignedUrl.mockReset().mockResolvedValue({ data: { signedUrl: "https://example.test/signed" }, error: null });
  });

  it("is exactly ten minutes", () => {
    expect(RECEIPT_URL_TTL_SECONDS).toBe(600);
  });

  it("asks Supabase for a link that expires at ten minutes, not the module constant by name", async () => {
    await expect(signedReceiptImageUrl("7/page.jpg")).resolves.toBe("https://example.test/signed");
    expect(supabaseAdmin.storage.from).toHaveBeenCalledWith("receipts");
    expect(createSignedUrl).toHaveBeenCalledTimes(1);
    expect(createSignedUrl).toHaveBeenCalledWith("7/page.jpg", 600);
  });

  it("degrades to null when the link cannot be minted", async () => {
    createSignedUrl.mockResolvedValueOnce({ data: null, error: new Error("bucket unavailable") });
    await expect(signedReceiptImageUrl("7/page.jpg")).resolves.toBeNull();
  });
});
