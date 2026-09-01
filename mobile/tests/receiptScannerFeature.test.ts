import { describe, expect, it } from "vitest";
import { receiptScannerEnabledFor } from "../src/lib/receiptScannerConfig";

describe("Android receipt-scanner feature flag", () => {
  it("is enabled by default and can be disabled explicitly on Android", () => {
    expect(receiptScannerEnabledFor("android", undefined)).toBe(true);
    expect(receiptScannerEnabledFor("android", true)).toBe(true);
    expect(receiptScannerEnabledFor("android", "false")).toBe(false);
  });

  it("keeps iOS deferred even when the shared configuration is enabled", () => {
    expect(receiptScannerEnabledFor("ios", true)).toBe(false);
  });

  it("never offers the Nitro-backed scanner inside Expo Go", () => {
    expect(receiptScannerEnabledFor("android", true, true)).toBe(false);
    expect(receiptScannerEnabledFor("android", undefined, true)).toBe(false);
  });
});
