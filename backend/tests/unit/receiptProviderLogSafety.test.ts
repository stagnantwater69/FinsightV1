import { beforeEach, describe, expect, it, vi } from "vitest";

const { logError, findCategories } = vi.hoisted(() => ({
  logError: vi.fn(),
  findCategories: vi.fn(),
}));

vi.mock("../../src/config/logger", () => ({
  logger: { error: logError, warn: vi.fn(), info: vi.fn(), fatal: vi.fn() },
}));
vi.mock("../../src/config/prisma", () => ({
  prisma: { expenseCategory: { findMany: findCategories } },
}));
vi.mock("../../src/lib/ownership", () => ({
  requireOwnedBusinessProfile: vi.fn(async () => undefined),
}));
vi.mock("../../src/lib/categoryHistory", () => ({
  loadConfirmedCategoryHistory: vi.fn(async () => []),
  categoryFromHistory: vi.fn(() => null),
}));

import { suggestCategoryForDescription } from "../../src/services/ai.service";

describe("receipt-adjacent provider log safety", () => {
  beforeEach(() => {
    logError.mockReset();
    findCategories.mockResolvedValue([{ id: 1, name: "Inventory" }]);
    vi.unstubAllGlobals();
  });

  it("does not log provider response bodies or receipt-derived category input", async () => {
    const providerBody = "PRIVATE_PROVIDER_BODY card=4111111111111111";
    const description = "PRIVATE_RECEIPT_ITEM";
    const vendor = "PRIVATE_VENDOR";
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(providerBody, { status: 502 }))
      .mockResolvedValueOnce(new Response(providerBody, { status: 503 })));

    await expect(suggestCategoryForDescription(1, 1, description, vendor)).resolves.toBeNull();

    expect(logError).toHaveBeenCalledTimes(2);
    for (const [context] of logError.mock.calls) {
      expect(context).toEqual({
        provider: expect.stringMatching(/^(gemini|openrouter)$/),
        operation: "expense-category-suggestion",
        failureKind: "provider-failure",
      });
    }
    expect(JSON.stringify(logError.mock.calls)).not.toMatch(
      /PRIVATE_PROVIDER_BODY|PRIVATE_RECEIPT_ITEM|PRIVATE_VENDOR|4111111111111111/,
    );
  });
});
