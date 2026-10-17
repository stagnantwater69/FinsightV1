// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useImportBatchPages } from "./useImportBatchPages";

const get = vi.hoisted(() => vi.fn());
vi.mock("./api", () => ({ api: { get } }));
function batch(id: number) { return { id, title: `Import ${id}`, uploadDate: "2026-10-13T00:00:00Z", status: "Reviewed", totalRows: 10, importedRows: 10, skippedRows: 0, flaggedRows: 0 }; }
beforeEach(() => { get.mockReset(); get.mockResolvedValue({ data: { items: [batch(1)], nextCursor: null } }); });

describe("CSV import history pages", () => {
  it.each([false, true])("rejects a repeated or cycling import cursor and preserves loaded imports (cycling: %s)", async (cycling) => {
    get.mockImplementation(async (_url: string, config: { params: { cursor?: string } }) => {
      if (!config.params.cursor) return { data: { items: [batch(1)], nextCursor: "cursor-a" } };
      if (cycling && config.params.cursor === "cursor-a") return { data: { items: [batch(2)], nextCursor: "cursor-b" } };
      return { data: { items: [batch(3)], nextCursor: "cursor-a" } };
    });
    const hook = renderHook(() => useImportBatchPages(1, true));
    await waitFor(() => expect(hook.result.current.items).toHaveLength(1));
    if (cycling) {
      act(() => hook.result.current.loadMore());
      await waitFor(() => expect(hook.result.current.items).toHaveLength(2));
    }
    const loaded = hook.result.current.items;
    const cursor = hook.result.current.nextCursor;
    act(() => hook.result.current.loadMore());
    await waitFor(() => expect(hook.result.current.loadingMore).toBe(false));
    expect(hook.result.current.error).not.toBeNull();
    expect(hook.result.current.items).toEqual(loaded);
    expect(hook.result.current.nextCursor).toBe(cursor);
    expect(get).toHaveBeenCalledTimes(cycling ? 3 : 2);
  });
  it("does not request history until the filter is enabled and sends the explicit page bound", async () => {
    const hook = renderHook(({ enabled }) => useImportBatchPages(1, enabled), { initialProps: { enabled: false } });
    expect(get).not.toHaveBeenCalled();
    hook.rerender({ enabled: true });
    await waitFor(() => expect(hook.result.current.items).toHaveLength(1));
    expect(get).toHaveBeenCalledWith("/records/csv-imports/batches", expect.objectContaining({ params: { businessProfileId: 1, pageSize: 50 } }));
  });

  it("retains loaded rows and the cursor after an older-page failure, then appends deduplicated results", async () => {
    get.mockResolvedValueOnce({ data: { items: [batch(1)], nextCursor: "older-imports" } });
    const hook = renderHook(() => useImportBatchPages(1, true));
    await waitFor(() => expect(hook.result.current.nextCursor).toBe("older-imports"));
    get.mockRejectedValueOnce(new Error("Older imports unavailable"));
    act(() => hook.result.current.loadMore());
    await waitFor(() => expect(hook.result.current.error).toBe("Older imports unavailable"));
    expect(hook.result.current.items.map((item) => item.id)).toEqual([1]);
    expect(hook.result.current.nextCursor).toBe("older-imports");
    get.mockResolvedValueOnce({ data: { items: [batch(1), batch(2)], nextCursor: null } });
    act(() => hook.result.current.loadMore());
    await waitFor(() => expect(hook.result.current.items.map((item) => item.id)).toEqual([1, 2]));
    expect(get.mock.calls.slice(1).map(([, config]) => config.params.cursor)).toEqual(["older-imports", "older-imports"]);
    expect(hook.result.current.error).toBeNull();
  });

  it("debounces a changed title search and drops the previous query's cursor", async () => {
    get.mockResolvedValueOnce({ data: { items: [batch(1)], nextCursor: "old-cursor" } });
    const hook = renderHook(() => useImportBatchPages(1, true));
    await waitFor(() => expect(hook.result.current.nextCursor).toBe("old-cursor"));
    act(() => { hook.result.current.setSearch("march"); hook.result.current.setSearch("march sales"); });
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    expect(get.mock.calls[1]![1].params).toEqual({ businessProfileId: 1, pageSize: 50, search: "march sales" });
    expect(hook.result.current.nextCursor).toBeNull();
  });

  it("aborts and discards the previous business's held history", async () => {
    let release!: (value: unknown) => void;
    get.mockReturnValueOnce(new Promise((resolve) => { release = resolve; }));
    const hook = renderHook(({ business }) => useImportBatchPages(business, true), { initialProps: { business: 1 } });
    const oldSignal = get.mock.calls[0]![1].signal as AbortSignal;
    hook.rerender({ business: 2 });
    await waitFor(() => expect(hook.result.current.loading).toBe(false));
    expect(oldSignal.aborted).toBe(true);
    await act(async () => { release({ data: { items: [batch(99)], nextCursor: "private-old-cursor" } }); });
    expect(hook.result.current.items.map((item) => item.id)).toEqual([1]);
    expect(hook.result.current.nextCursor).toBeNull();
    expect(get.mock.calls[1]![1].params.businessProfileId).toBe(2);
  });
});
