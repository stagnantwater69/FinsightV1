import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";

/*
 * THE WARM TESSERACT WORKER POOL.
 *
 * ocr.service used to create and terminate a tesseract.js worker around every
 * recognition, paying the WASM + language-data cold start twice per page. It
 * now keeps a small pool warm. These pin the lifecycle rules that make that
 * safe rather than the speed:
 *   - a worker is created once and reused, not once per call;
 *   - at most two workers exist however many calls arrive at once;
 *   - a recognition that rejects discards its worker, so a broken engine is
 *     never reused, and the next call gets a fresh one;
 *   - shutdownOcr terminates the pool, and a later call starts again;
 *   - a call carrying engine parameters (the accuracy harness's PSM sweep)
 *     uses a throwaway worker so its settings never leak into the pool;
 *   - the options handed to createWorker are exactly the packaged-offline
 *     ones (langPath, gzip: false, cacheMethod: "none").
 *
 * tesseract.js is mocked; nothing here runs the engine. The engine's output
 * being unchanged by pooling is evidenced by the accuracy harness, not here.
 */

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void };
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface FakeWorker {
  id: number;
  recognize: ReturnType<typeof vi.fn>;
  setParameters: ReturnType<typeof vi.fn>;
  terminate: ReturnType<typeof vi.fn>;
  worker: { ref: ReturnType<typeof vi.fn>; unref: ReturnType<typeof vi.fn>; once: ReturnType<typeof vi.fn> };
}

const created: FakeWorker[] = [];
async function fakeWorker(..._args: unknown[]): Promise<FakeWorker> {
  const id = created.length + 1;
  const fake: FakeWorker = {
    id,
    recognize: vi.fn(async () => ({ data: { text: `read by worker ${id}`, confidence: 90, blocks: [] } })),
    setParameters: vi.fn(async () => ({})),
    terminate: vi.fn(async () => ({})),
    worker: { ref: vi.fn(), unref: vi.fn(), once: vi.fn() },
  };
  created.push(fake);
  return fake;
}
const createWorkerMock = vi.fn(fakeWorker);

vi.mock("tesseract.js", () => ({ createWorker: (...args: unknown[]) => createWorkerMock(...args) }));

async function png() {
  return sharp({ create: { width: 40, height: 20, channels: 3, background: "white" } }).png().toBuffer();
}

describe("warm tesseract worker pool", () => {
  let ocr: typeof import("../../src/services/ocr.service");

  beforeEach(async () => {
    vi.resetModules();
    created.length = 0;
    // mockReset, not mockClear: the concurrency test swaps in a gated
    // implementation that must not survive into the next test.
    createWorkerMock.mockReset();
    createWorkerMock.mockImplementation(fakeWorker);
    ocr = await import("../../src/services/ocr.service");
  });

  afterEach(async () => {
    await ocr.shutdownOcr();
  });

  it("creates one worker and reuses it across sequential calls", async () => {
    const image = await png();
    const first = await ocr.extractReceipt(image);
    const second = await ocr.extractReceipt(image);
    const third = await ocr.extractText(image);

    expect(createWorkerMock).toHaveBeenCalledTimes(1);
    expect(created[0]!.recognize).toHaveBeenCalledTimes(3);
    expect(created[0]!.terminate).not.toHaveBeenCalled();
    expect(first.text).toBe("read by worker 1");
    expect(second.text).toBe("read by worker 1");
    expect(third).toBe("read by worker 1");
  });

  it("passes the packaged-offline worker options unchanged", async () => {
    await ocr.extractText(await png());
    const [lang, oem, options] = createWorkerMock.mock.calls[0]!;
    expect(lang).toBe("eng");
    expect(oem).toBeUndefined();
    expect(options).toMatchObject({ gzip: false, cacheMethod: "none" });
    expect(typeof (options as { langPath: string }).langPath).toBe("string");
  });

  it("caps concurrent workers at two and queues the rest", async () => {
    const image = await png();
    const gates: Deferred<unknown>[] = [];
    // Every recognition blocks until this test releases it, so the three
    // calls below are genuinely in flight at the same time.
    createWorkerMock.mockImplementation(async () => {
      const fake: FakeWorker = {
        id: created.length + 1,
        recognize: vi.fn(() => {
          const gate = deferred<unknown>();
          gates.push(gate);
          return gate.promise.then(() => ({ data: { text: "t", confidence: 1, blocks: [] } }));
        }),
        setParameters: vi.fn(async () => ({})),
        terminate: vi.fn(async () => ({})),
        worker: { ref: vi.fn(), unref: vi.fn(), once: vi.fn() },
      };
      created.push(fake);
      return fake;
    });

    const calls = [ocr.extractText(image), ocr.extractText(image), ocr.extractText(image)];
    await vi.waitFor(() => expect(gates.length).toBe(2));
    expect(createWorkerMock).toHaveBeenCalledTimes(2);

    gates[0]!.resolve(null);
    await vi.waitFor(() => expect(gates.length).toBe(3));
    // The third call ran on a freed worker, not a third one.
    expect(createWorkerMock).toHaveBeenCalledTimes(2);

    gates[1]!.resolve(null);
    gates[2]!.resolve(null);
    await Promise.all(calls);
  });

  it("refs the thread while a job runs and unrefs it when idle", async () => {
    await ocr.extractText(await png());
    const thread = created[0]!.worker;
    expect(thread.ref).toHaveBeenCalledTimes(1);
    // Once at creation (idle), once after the job.
    expect(thread.unref).toHaveBeenCalledTimes(2);
  });

  it("discards a worker whose recognition rejected and starts a fresh one", async () => {
    const image = await png();
    await ocr.extractText(image);
    created[0]!.recognize.mockRejectedValueOnce(new Error("engine fault"));

    await expect(ocr.extractText(image)).rejects.toThrow("engine fault");
    expect(created[0]!.terminate).toHaveBeenCalledTimes(1);

    const text = await ocr.extractText(image);
    expect(createWorkerMock).toHaveBeenCalledTimes(2);
    expect(text).toBe("read by worker 2");
  });

  it("starts a fresh worker when the thread exits on its own", async () => {
    const image = await png();
    await ocr.extractText(image);
    const onExit = created[0]!.worker.once.mock.calls.find(([event]) => event === "exit")?.[1] as () => void;
    expect(onExit).toBeTypeOf("function");
    onExit();

    const text = await ocr.extractText(image);
    expect(createWorkerMock).toHaveBeenCalledTimes(2);
    expect(text).toBe("read by worker 2");
  });

  it("shutdownOcr terminates the pool; a later call starts over", async () => {
    const image = await png();
    await ocr.extractText(image);
    await ocr.shutdownOcr();
    expect(created[0]!.terminate).toHaveBeenCalledTimes(1);

    // Safe to call with nothing warm.
    await ocr.shutdownOcr();

    const text = await ocr.extractText(image);
    expect(createWorkerMock).toHaveBeenCalledTimes(2);
    expect(text).toBe("read by worker 2");
  });

  it("uses a throwaway worker for calls that set engine parameters", async () => {
    const image = await png();
    await ocr.extractText(image, { pageSegMode: "4" });
    expect(createWorkerMock).toHaveBeenCalledTimes(1);
    expect(created[0]!.setParameters).toHaveBeenCalledWith({ tessedit_pageseg_mode: "4" });
    expect(created[0]!.terminate).toHaveBeenCalledTimes(1);

    // The pool was untouched: a plain call afterwards gets its own, fresh
    // worker with no parameters set on it.
    await ocr.extractText(image);
    expect(createWorkerMock).toHaveBeenCalledTimes(2);
    expect(created[1]!.setParameters).not.toHaveBeenCalled();
    expect(created[1]!.terminate).not.toHaveBeenCalled();
  });
});
