import { describe, expect, it, vi } from "vitest";
import {
  createScannerLaunchGuard,
  launchReceiptScanner,
} from "../src/lib/receiptScannerLaunch";
import { MAX_SECTIONS, type ReceiptSection } from "../src/lib/receiptCapture";

function section(id: string): ReceiptSection {
  return {
    localId: id,
    originalUri: `file:///${id}.jpg`,
    processedUri: `file:///${id}.jpg`,
    width: 100,
    height: 200,
    quality: null,
    captureSource: "native-document-scanner",
  };
}

describe("launchReceiptScanner", () => {
  it("never calls the native scanner when the runtime cannot support it", async () => {
    const scan = vi.fn();
    const outcome = await launchReceiptScanner([], scan, false);
    expect(outcome).toEqual({ kind: "unsupported" });
    expect(scan).not.toHaveBeenCalled();
  });

  it("returns success with pages appended, in the order the scanner returned them", async () => {
    const existing = [section("a")];
    const scanned = [section("b"), section("c")];
    const scan = vi.fn().mockResolvedValue(scanned);

    const outcome = await launchReceiptScanner(existing, scan, true);

    expect(outcome.kind).toBe("success");
    if (outcome.kind === "success") {
      expect(outcome.sections.map((s) => s.localId)).toEqual(["a", "b", "c"]);
    }
  });

  it("enforces the eight-page maximum before calling the scanner", async () => {
    const existing = Array.from({ length: MAX_SECTIONS }, (_, i) => section(`existing-${i}`));
    const scan = vi.fn();

    const outcome = await launchReceiptScanner(existing, scan, true);

    expect(outcome).toEqual({
      kind: "failure",
      message: "This receipt already has the most sections FinSight can hold.",
    });
    expect(scan).not.toHaveBeenCalled();
  });

  it("passes only the REMAINING capacity to the scanner, not the whole ceiling", async () => {
    const existing = [section("a"), section("b")];
    const scan = vi.fn().mockResolvedValue([section("c")]);

    await launchReceiptScanner(existing, scan, true);

    expect(scan).toHaveBeenCalledWith(MAX_SECTIONS - existing.length);
  });

  it("treats a scanner cancellation as returning to the previous screen, not an error", async () => {
    const scan = vi.fn().mockRejectedValue(new Error("User canceled document scan"));
    const outcome = await launchReceiptScanner([], scan, true);
    expect(outcome).toEqual({ kind: "cancelled" });
  });

  it("treats an empty page result the same as a cancellation", async () => {
    const scan = vi.fn().mockResolvedValue([]);
    const outcome = await launchReceiptScanner([], scan, true);
    expect(outcome).toEqual({ kind: "cancelled" });
  });

  it("surfaces a genuine scanner failure with recovery copy, never a raw error", async () => {
    const scan = vi.fn().mockRejectedValue(new Error("NitroModules: module not found"));
    const outcome = await launchReceiptScanner([], scan, true);
    expect(outcome).toEqual({
      kind: "failure",
      message: "Auto scan couldn't start on this device or build.",
    });
  });

  it("long receipts stay one receipt: returned pages never receive separate receiptGroupIds", async () => {
    const scan = vi.fn().mockResolvedValue([section("a"), section("b"), section("c")]);
    const outcome = await launchReceiptScanner([], scan, true);
    expect(outcome.kind).toBe("success");
    if (outcome.kind === "success") {
      for (const s of outcome.sections) expect(s.receiptGroupId).toBeUndefined();
    }
  });
});

describe("createScannerLaunchGuard", () => {
  it("prevents a second launch while one is already in flight", () => {
    const guard = createScannerLaunchGuard();
    expect(guard.tryEnter()).toBe(true);
    expect(guard.isInFlight).toBe(true);
    // A second attempt — e.g. a fast double-tap on "Retry scanner" — must not
    // also acquire the lock.
    expect(guard.tryEnter()).toBe(false);
  });

  it("allows a new launch once the previous one has exited", () => {
    const guard = createScannerLaunchGuard();
    expect(guard.tryEnter()).toBe(true);
    guard.exit();
    expect(guard.isInFlight).toBe(false);
    expect(guard.tryEnter()).toBe(true);
  });

  it("exit is safe to call even when nothing was locked", () => {
    const guard = createScannerLaunchGuard();
    expect(() => guard.exit()).not.toThrow();
    expect(guard.isInFlight).toBe(false);
  });
});
