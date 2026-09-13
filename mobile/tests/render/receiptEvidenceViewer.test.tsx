import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, waitFor } from "@testing-library/react-native";
import { ThemeProvider } from "../../src/context/ThemeContext";
import { ReceiptEvidenceViewer } from "../../src/screens/records/scanReceipt/ReceiptEvidenceViewer";
import { receiptEvidenceLabels } from "../../src/screens/records/scanReceipt/receiptEvidence";
import type { CapturedPage, ReceiptPageEvidence } from "../../src/screens/records/scanReceipt/types";

const apiGet = vi.fn();

vi.mock("../../src/lib/api", () => ({
  api: { get: (...args: unknown[]) => apiGet(...args) },
}));

const page = (key: string, overrides: Partial<CapturedPage> = {}): CapturedPage => ({
  key,
  uri: `file:///${key}-processed.jpg`,
  originalUri: `file:///${key}-source.jpg`,
  fileName: `${key}.jpg`,
  mimeType: "image/jpeg",
  originalMimeType: "image/jpeg",
  quality: null,
  checkingQuality: false,
  width: 1000,
  height: 2000,
  originalWidth: 1200,
  originalHeight: 2400,
  captureSource: "manual-camera",
  processingMode: "manual-crop",
  ...overrides,
});

const withTheme = (node: React.ReactNode) => <ThemeProvider initialMode="dark">{node}</ThemeProvider>;

const evidence: ReceiptPageEvidence[] = [{
  pageNumber: 1,
  captureMode: "standard",
  processingMode: "clear-colour",
  ocrInput: "derived",
  source: { variant: "source", label: "Unenhanced scan", width: 3024, height: 4032 },
  derived: { variant: "derived", label: "Enhanced color", width: 1800, height: 3000 },
}];

describe("ReceiptEvidenceViewer", () => {
  beforeEach(() => {
    apiGet.mockReset();
  });

  it("opens on immutable source evidence, then exposes the edited image without replacing it", async () => {
    const close = vi.fn();
    const q = await render(withTheme(
      <ReceiptEvidenceViewer pages={[page("one")]} initialPage={0} visible onClose={close} />,
    ));

    expect(q.getByRole("image", { name: "Receipt page 1, Source photo" }).props.source.uri).toBe("file:///one-source.jpg");
    expect(q.getByRole("tab", { name: "Source photo" }).props.accessibilityState.selected).toBe(true);
    await fireEvent.press(q.getByRole("tab", { name: "Rectified" }));
    expect(q.getByRole("image", { name: "Receipt page 1, Rectified" }).props.source.uri).toBe("file:///one-processed.jpg");
    expect(q.getByRole("tab", { name: "Rectified" }).props.accessibilityState.selected).toBe(true);

    await fireEvent.press(q.getByRole("button", { name: "Close receipt image" }));
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("switches pages, resets to source evidence, and provides button-operated zoom", async () => {
    const q = await render(withTheme(
      <ReceiptEvidenceViewer pages={[page("one"), page("two")]} initialPage={0} visible onClose={vi.fn()} />,
    ));

    await fireEvent.press(q.getByRole("tab", { name: "Rectified" }));
    await fireEvent.press(q.getByRole("button", { name: "Zoom in" }));
    expect(q.getByRole("button", { name: "Reset 1.5×" })).toBeEnabled();
    await fireEvent.press(q.getByRole("button", { name: "Show receipt page 2" }));
    expect(q.getByRole("header", { name: "Receipt page 2 of 2" })).toBeTruthy();
    expect(q.getByRole("image", { name: "Receipt page 2, Source photo" }).props.source.uri).toBe("file:///two-source.jpg");
    expect(q.getByRole("button", { name: "Actual view" })).toBeDisabled();
  });

  it("labels a continuous long receipt as a composite instead of an original photo", () => {
    expect(receiptEvidenceLabels(page("long", {
      captureSource: "native-document-scanner",
      captureMode: "long",
      processingMode: "native-selected",
    })).source).toBe("Composite source");
  });

  it("falls back to the local source if a signed stored URL expires", async () => {
    apiGet.mockResolvedValue({
      pageNumber: 1,
      variant: "source",
      label: "Unenhanced scan",
      width: 3024,
      height: 4032,
      url: "https://storage.test/source-signed",
      expiresInSeconds: 600,
    });
    const q = await render(withTheme(
      <ReceiptEvidenceViewer pages={[page("one")]} scanId={41} pageEvidence={evidence} initialPage={0} visible onClose={vi.fn()} />,
    ));

    await waitFor(() => {
      expect(q.getByRole("image", { name: "Receipt page 1, Unenhanced scan" }).props.source.uri)
        .toBe("https://storage.test/source-signed");
    });
    await fireEvent(q.getByRole("image", { name: "Receipt page 1, Unenhanced scan" }), "error");

    await waitFor(() => {
      expect(q.getByRole("image", { name: "Receipt page 1, Unenhanced scan" }).props.source.uri)
        .toBe("file:///one-source.jpg");
    });
    expect(q.getByRole("alert", { name: /stored image is temporarily unavailable/i })).toBeTruthy();
  });

  it("offers a fresh stored link if both the expired URL and local fallback fail", async () => {
    apiGet.mockResolvedValue({
      pageNumber: 1,
      variant: "source",
      label: "Unenhanced scan",
      width: 3024,
      height: 4032,
      url: "https://storage.test/source-signed",
      expiresInSeconds: 600,
    });
    const q = await render(withTheme(
      <ReceiptEvidenceViewer pages={[page("one")]} scanId={41} pageEvidence={evidence} initialPage={0} visible onClose={vi.fn()} />,
    ));

    await waitFor(() => expect(q.getByRole("image", { name: "Receipt page 1, Unenhanced scan" }).props.source.uri)
      .toBe("https://storage.test/source-signed"));
    await fireEvent(q.getByRole("image", { name: "Receipt page 1, Unenhanced scan" }), "error");
    await waitFor(() => expect(q.getByRole("image", { name: "Receipt page 1, Unenhanced scan" }).props.source.uri)
      .toBe("file:///one-source.jpg"));
    await fireEvent(q.getByRole("image", { name: "Receipt page 1, Unenhanced scan" }), "error");

    await waitFor(() => expect(q.getByRole("alert", { name: /neither copy/i })).toBeTruthy());
    expect(q.getByRole("button", { name: "Try stored image again" })).toBeEnabled();
  });

  it("can inspect stored source evidence when the local photo is no longer available", async () => {
    apiGet.mockResolvedValue({
      pageNumber: 1,
      variant: "source",
      label: "Unenhanced scan",
      width: 3024,
      height: 4032,
      url: "https://storage.test/stored-only-source",
      expiresInSeconds: 600,
    });
    const q = await render(withTheme(
      <ReceiptEvidenceViewer
        pages={[page("stored", { uri: "", originalUri: undefined })]}
        scanId={52}
        pageEvidence={evidence}
        initialPage={0}
        visible
        onClose={vi.fn()}
      />,
    ));

    await waitFor(() => {
      expect(q.getByRole("image", { name: "Receipt page 1, Unenhanced scan" }).props.source.uri)
        .toBe("https://storage.test/stored-only-source");
    });
    expect(apiGet).toHaveBeenCalledWith("/records/receipts/52/pages/1/image/source");
  });
});
