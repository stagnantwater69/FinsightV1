import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * The upload retry used to fire on every failure, immediately.
 *
 * Both halves cost the owner something. A 4xx is Storage stating a fact about
 * this exact request, so repeating it verbatim buys a second round trip and
 * the same 502. And a retry in the same tick re-runs the request while
 * whatever caused the first failure is still happening.
 */

const { remove, upload } = vi.hoisted(() => ({ remove: vi.fn(), upload: vi.fn() }));

vi.mock("../../src/config/supabase", () => ({
  supabaseAdmin: { storage: { from: vi.fn(() => ({ remove, upload })) } },
}));
vi.mock("../../src/config/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import { deleteCsvFile, deleteReceiptImage, uploadReceiptImage } from "../../src/services/storage.service";

const IMAGE = Buffer.from([0xff, 0xd8, 0xff]);

function failWith(error: Record<string, unknown>) {
  return { data: null, error };
}

beforeEach(() => {
  remove.mockReset();
  upload.mockReset();
});

describe("storage upload retry", () => {
  it("does not spend a second round trip on an answer that will not change", async () => {
    upload.mockResolvedValue(failWith({ status: 400, message: "Invalid path" }));

    await expect(uploadReceiptImage(7, IMAGE, "image/jpeg", "receipt.jpg")).rejects.toMatchObject({
      status: 502,
    });
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it("treats the string statusCode Storage actually returns the same way", async () => {
    // supabase-js reports these as strings on the storage error object.
    upload.mockResolvedValue(failWith({ statusCode: "409", message: "The resource already exists" }));

    await expect(uploadReceiptImage(7, IMAGE, "image/jpeg", "receipt.jpg")).rejects.toMatchObject({
      status: 502,
    });
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it("retries a rate limit, which is the one 4xx that means 'later'", async () => {
    upload
      .mockResolvedValueOnce(failWith({ status: 429, message: "Too many requests" }))
      .mockResolvedValueOnce({ data: { path: "7/x.jpg" }, error: null });

    await expect(uploadReceiptImage(7, IMAGE, "image/jpeg", "receipt.jpg")).resolves.toMatch(/^7\//);
    expect(upload).toHaveBeenCalledTimes(2);
  });

  it("retries a 5xx and a transport failure with no status at all", async () => {
    upload
      .mockResolvedValueOnce(failWith({ status: 503, message: "Service unavailable" }))
      .mockResolvedValueOnce({ data: { path: "7/x.jpg" }, error: null });
    await expect(uploadReceiptImage(7, IMAGE, "image/jpeg", "receipt.jpg")).resolves.toMatch(/^7\//);

    upload.mockReset();
    upload
      .mockResolvedValueOnce(failWith({ message: "fetch failed" }))
      .mockResolvedValueOnce({ data: { path: "7/x.jpg" }, error: null });
    await expect(uploadReceiptImage(7, IMAGE, "image/jpeg", "receipt.jpg")).resolves.toMatch(/^7\//);
  });

  it("waits before the retry instead of re-firing in the same tick", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      upload
        .mockResolvedValueOnce(failWith({ status: 503, message: "Service unavailable" }))
        .mockResolvedValueOnce({ data: { path: "7/x.jpg" }, error: null });

      const pending = uploadReceiptImage(7, IMAGE, "image/jpeg", "receipt.jpg");
      // Let the first attempt settle, then check nothing has retried yet.
      await vi.advanceTimersByTimeAsync(0);
      expect(upload).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(250);
      await expect(pending).resolves.toMatch(/^7\//);
      expect(upload).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("still gives up after the second attempt", async () => {
    upload.mockResolvedValue(failWith({ status: 503, message: "Service unavailable" }));

    await expect(uploadReceiptImage(7, IMAGE, "image/jpeg", "receipt.jpg")).rejects.toMatchObject({
      status: 502,
    });
    expect(upload).toHaveBeenCalledTimes(2);
  });
});

describe("storage deletion retry", () => {
  it.each([
    ["receipt", () => deleteReceiptImage("7/receipt.jpg")],
    ["CSV", () => deleteCsvFile("7/books.csv")],
  ])("retries one transient failure while deleting a %s object", async (_kind, removeFile) => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      remove
        .mockResolvedValueOnce(failWith({ status: 503, message: "Service unavailable" }))
        .mockResolvedValueOnce({ data: {}, error: null });

      const pending = removeFile();
      await vi.advanceTimersByTimeAsync(0);
      expect(remove).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(250);
      await expect(pending).resolves.toBe(true);
      expect(remove).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries a rate limit expressed through Supabase's string statusCode", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      remove
        .mockResolvedValueOnce(failWith({ statusCode: "429", message: "Too many requests" }))
        .mockResolvedValueOnce({ data: {}, error: null });

      const pending = deleteReceiptImage("7/receipt.jpg");
      await vi.advanceTimersByTimeAsync(250);

      await expect(pending).resolves.toBe(true);
      expect(remove).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not retry a terminal 4xx deletion failure", async () => {
    remove.mockResolvedValue(failWith({ status: 403, message: "Forbidden" }));

    await expect(deleteReceiptImage("7/receipt.jpg")).resolves.toBe(false);
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it("returns false after the one allowed retry is exhausted", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      remove.mockResolvedValue(failWith({ status: 503, message: "Service unavailable" }));

      const pending = deleteCsvFile("7/books.csv");
      await vi.advanceTimersByTimeAsync(250);

      await expect(pending).resolves.toBe(false);
      expect(remove).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
