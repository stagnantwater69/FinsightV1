import { describe, expect, it } from "vitest";
import {
  addSessionSections,
  createReceiptSection,
  moveSessionSection,
  qualityHint,
  removeSessionSection,
} from "../src/lib/receiptCameraSession";
import { MAX_SECTIONS } from "../src/lib/receiptCapture";

const section = (id: string) => ({
  ...createReceiptSection({ uri: `file:///${id}.jpg`, width: 1800, height: 3200 }, "manual-camera"),
  localId: id,
});

describe("custom camera section provenance", () => {
  it.each([
    { uri: "", width: 1800, height: 3200 },
    { uri: "file:///bad.jpg", width: 0, height: 3200 },
    { uri: "file:///bad.jpg", width: 1800, height: Number.NaN },
    { uri: "file:///bad.jpg", width: Number.POSITIVE_INFINITY, height: 3200 },
  ])("rejects unusable image assets before they reach upload", (asset) => {
    expect(() => createReceiptSection(asset, "gallery")).toThrow();
  });
  it.each(["manual-camera", "gallery"] as const)("preserves original evidence from %s", (source) => {
    const created = createReceiptSection({ uri: "file:///receipt.jpg", width: 1800, height: 3200 }, source);
    expect(created).toMatchObject({
      originalUri: "file:///receipt.jpg",
      processedUri: "file:///receipt.jpg",
      width: 1800,
      height: 3200,
      captureSource: source,
      quality: null,
    });
    expect(created.localId).toBeTruthy();
    expect(created.receiptGroupId).toBeUndefined();
  });
});

describe("ordered camera and gallery session", () => {
  it("mixes camera and gallery sections without splitting one receipt into purchases", () => {
    const camera = section("camera");
    const gallery = createReceiptSection({ uri: "file:///gallery.jpg", width: 1800, height: 3200 }, "gallery");
    const result = addSessionSections([camera], [gallery]);
    expect(result.map((item) => item.captureSource)).toEqual(["manual-camera", "gallery"]);
    expect(result.map((item) => item.originalUri)).toEqual([camera.originalUri, gallery.originalUri]);
    expect(result.every((item) => item.receiptGroupId === undefined)).toBe(true);
  });

  it("deduplicates repeated gallery selections while retaining their first position", () => {
    const existing = section("existing");
    const fresh = section("fresh");
    const result = addSessionSections([existing], [{ ...existing, localId: "duplicate" }, fresh, fresh]);
    expect(result.map((item) => item.originalUri)).toEqual([existing.originalUri, fresh.originalUri]);
  });

  it("accepts exactly eight sections and rejects overflow without changing the session", () => {
    const current = Array.from({ length: MAX_SECTIONS - 1 }, (_, index) => section(`page-${index}`));
    expect(addSessionSections(current, [section("last")])).toHaveLength(MAX_SECTIONS);
    expect(() => addSessionSections(current, [section("last"), section("excess")])).toThrow();
    expect(current).toHaveLength(MAX_SECTIONS - 1);
  });

  it("retakes a section in place at capacity and retains its receipt grouping", () => {
    const current = Array.from({ length: MAX_SECTIONS }, (_, index) => ({ ...section(`page-${index}`), receiptGroupId: "receipt-a" }));
    const result = addSessionSections(current, [section("retaken")], "page-3");
    expect(result).toHaveLength(MAX_SECTIONS);
    expect(result[3]).toMatchObject({ originalUri: "file:///retaken.jpg", receiptGroupId: "receipt-a" });
    expect(result.filter((_, index) => index !== 3)).toEqual(current.filter((_, index) => index !== 3));
    expect(current[3]!.originalUri).toBe("file:///page-3.jpg");
  });

  it("rejects stale retakes after the intended section was removed", () => {
    expect(() => addSessionSections([section("remaining")], [section("retaken")], "removed")).toThrow();
  });

  it("rejects replacing one section with an existing image or several images", () => {
    const current = [section("a"), section("b")];
    expect(() => addSessionSections(current, [section("b")], "a")).toThrow();
    expect(() => addSessionSections(current, [section("c"), section("d")], "a")).toThrow();
    expect(current.map((item) => item.localId)).toEqual(["a", "b"]);
  });

  it("adds new pages to an existing receipt group", () => {
    const current = [{ ...section("a"), receiptGroupId: "receipt-a" }];
    expect(addSessionSections(current, [section("b")])[1]!.receiptGroupId).toBe("receipt-a");
  });

  it("moves and removes by stable identity after an earlier reorder", () => {
    const current = [section("a"), section("b"), section("c")];
    const reordered = moveSessionSection(current, "c", -1);
    expect(reordered.map((item) => item.localId)).toEqual(["a", "c", "b"]);
    expect(removeSessionSection(reordered, "b").map((item) => item.localId)).toEqual(["a", "c"]);
    expect(current.map((item) => item.localId)).toEqual(["a", "b", "c"]);
  });

  it("leaves the session safe when stale controls reference missing sections or endpoints", () => {
    const current = [section("a"), section("b")];
    expect(moveSessionSection(current, "a", -1)).toEqual(current);
    expect(moveSessionSection(current, "missing", 1)).toEqual(current);
    expect(removeSessionSection(current, "missing")).toEqual(current);
  });
});

describe("advisory quality feedback", () => {
  it("does not invent a successful reading when the quality service did not answer", () => {
    expect(qualityHint(null)).toBeNull();
  });

  it("warns about unreadable capture dimensions and blur", () => {
    expect(qualityHint({ sharpness: 80, brightness: 140, tooBlurredToTrust: false, tooSmallToRead: true })).toBeTruthy();
    expect(qualityHint({ sharpness: 0, brightness: 140, tooBlurredToTrust: true })).toBeTruthy();
  });
});
