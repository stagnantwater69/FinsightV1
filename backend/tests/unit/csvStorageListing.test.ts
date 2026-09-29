import { beforeEach, describe, expect, it, vi } from "vitest";

const { list } = vi.hoisted(() => ({ list: vi.fn() }));

vi.mock("../../src/config/supabase", () => ({
  supabaseAdmin: { storage: { from: vi.fn(() => ({ list })) } },
}));

import { listCsvFilesForProfile } from "../../src/services/storage.service";

beforeEach(() => list.mockReset());

describe("CSV Storage inventory", () => {
  it("pages within one profile and reports truncation without exposing names outside it", async () => {
    list
      .mockResolvedValueOnce({
        data: Array.from({ length: 100 }, (_, index) => ({
          id: index === 99 ? null : String(index),
          name: index === 99 ? "folder" : `${index}.csv`,
          created_at: "2026-09-01",
          updated_at: null,
        })),
        error: null,
      })
      .mockResolvedValueOnce({
        data: [{ id: "b", name: "b.csv", created_at: "2026-09-02", updated_at: null }],
        error: null,
      });

    const inventory = await listCsvFilesForProfile(42, 100, 10);
    expect(list).toHaveBeenNthCalledWith(1, "42", {
      limit: 100,
      offset: 10,
      sortBy: { column: "name", order: "asc" },
    });
    expect(list).toHaveBeenNthCalledWith(2, "42", {
      limit: 1,
      offset: 110,
      sortBy: { column: "name", order: "asc" },
    });
    expect(inventory.objects).toHaveLength(100);
    expect(inventory.objects[0]).toEqual({ path: "42/0.csv", createdAt: "2026-09-01", updatedAt: null });
    expect(inventory.objects.at(-1)).toEqual({ path: "42/b.csv", createdAt: "2026-09-02", updatedAt: null });
    expect(inventory.truncated).toBe(true);
  });

  it("fails the inventory when Storage returns an error", async () => {
    list.mockResolvedValue({ data: null, error: { message: "Storage unavailable" } });
    await expect(listCsvFilesForProfile(42, 100)).rejects.toThrow("Could not list CSV Storage objects");
  });
});
