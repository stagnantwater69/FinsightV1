import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render } from "@testing-library/react-native";
import { ThemeProvider } from "../../src/context/ThemeContext";
import { ReceiptEvidenceViewer } from "../../src/screens/records/scanReceipt/ReceiptEvidenceViewer";
import type { CapturedPage, ReceiptPageEvidence, ReceiptPageImage } from "../../src/screens/records/scanReceipt/types";

// P2-9: a superseded stored-image request must neither veil another page nor
// write state for it. Requests are deferred so each test decides when they settle.

type Deferred = {
  path: string;
  resolve: (value: ReceiptPageImage) => void;
  reject: (error: Error) => void;
};

const apiGet = vi.fn();
const pending: Deferred[] = [];

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

const evidenceFor = (pageNumber: number): ReceiptPageEvidence => ({
  pageNumber,
  captureMode: "standard",
  processingMode: "clear-colour",
  ocrInput: "derived",
  source: { variant: "source", label: "Unenhanced scan", width: 3024, height: 4032 },
  derived: { variant: "derived", label: "Enhanced color", width: 1800, height: 3000 },
});

const storedImage = (pageNumber: number, url: string): ReceiptPageImage => ({
  pageNumber,
  variant: "source",
  label: "Unenhanced scan",
  width: 3024,
  height: 4032,
  url,
  expiresInSeconds: 600,
});

const withTheme = (node: React.ReactNode) => <ThemeProvider initialMode="dark">{node}</ThemeProvider>;

const pages = [page("one"), page("two"), page("three")];
const evidence = [evidenceFor(1), evidenceFor(2), evidenceFor(3)];
const imagePath = (pageNumber: number) => `/records/receipts/77/pages/${pageNumber}/image/source`;

function mount(overrides: { pages?: CapturedPage[]; pageEvidence?: ReceiptPageEvidence[] } = {}) {
  return render(withTheme(
    <ReceiptEvidenceViewer
      pages={overrides.pages ?? pages}
      scanId={77}
      pageEvidence={overrides.pageEvidence ?? evidence}
      initialPage={0}
      visible
      onClose={vi.fn()}
    />,
  ));
}

type Queries = Awaited<ReturnType<typeof mount>>;

const veil = (q: Queries) => q.queryByText(/^Opening /);
const image = (q: Queries, pageNumber: number) => q.getByRole("image", { name: `Receipt page ${pageNumber}, Unenhanced scan` });

// The <Image> mock never fires load events, so settle the image by hand.
// Any veil left after this belongs to the stored-image request.
async function settleImage(q: Queries, pageNumber: number) {
  await fireEvent(image(q, pageNumber), "loadEnd");
}

async function showPage(q: Queries, pageNumber: number) {
  await fireEvent.press(q.getByRole("button", { name: `Show receipt page ${pageNumber}` }));
  await settleImage(q, pageNumber);
}

function takePending(pageNumber: number): Deferred {
  const index = pending.findIndex((request) => request.path === imagePath(pageNumber));
  if (index < 0) throw new Error(`No pending stored-image request for page ${pageNumber}`);
  return pending.splice(index, 1)[0];
}

async function resolvePending(pageNumber: number, url: string) {
  const request = takePending(pageNumber);
  await act(async () => { request.resolve(storedImage(pageNumber, url)); });
}

async function rejectPending(pageNumber: number) {
  const request = takePending(pageNumber);
  await act(async () => { request.reject(new Error("offline")); });
}

describe("ReceiptEvidenceViewer stored-image loading", () => {
  beforeEach(() => {
    apiGet.mockReset();
    pending.length = 0;
    apiGet.mockImplementation((path: string) => new Promise<ReceiptPageImage>((resolve, reject) => {
      pending.push({ path, resolve, reject });
    }));
  });

  afterEach(() => {
    pending.length = 0;
  });

  it("clears the veil after switching away and back before the first request settles, and ignores the stale result", async () => {
    const q = await mount();
    await settleImage(q, 1);
    expect(apiGet).toHaveBeenCalledTimes(1);
    const stale = takePending(1);
    expect(veil(q)).toBeTruthy();

    await showPage(q, 2);
    await showPage(q, 1);
    expect(apiGet).toHaveBeenCalledTimes(3);
    expect(veil(q)).toBeTruthy();

    await act(async () => { stale.resolve(storedImage(1, "https://storage.test/stale-page-1")); });
    expect(image(q, 1).props.source.uri).toBe("file:///one-source.jpg");

    await resolvePending(1, "https://storage.test/fresh-page-1");
    await settleImage(q, 1);
    expect(image(q, 1).props.source.uri).toBe("https://storage.test/fresh-page-1");
    expect(veil(q)).toBeNull();
  });

  it("does not veil a cached page while another page's request is still in flight", async () => {
    const q = await mount();
    await settleImage(q, 1);
    await resolvePending(1, "https://storage.test/page-1");
    await settleImage(q, 1);
    expect(veil(q)).toBeNull();

    await showPage(q, 2);
    expect(veil(q)).toBeTruthy();

    await showPage(q, 1);
    expect(image(q, 1).props.source.uri).toBe("https://storage.test/page-1");
    expect(veil(q)).toBeNull();
    expect(apiGet).toHaveBeenCalledTimes(2);
  });

  it("does not veil a failed page while another page's request is still in flight", async () => {
    const q = await mount();
    await settleImage(q, 1);
    await rejectPending(1);
    expect(veil(q)).toBeNull();
    expect(q.getByRole("alert", { name: /stored image is temporarily unavailable/i })).toBeTruthy();

    await showPage(q, 2);
    expect(veil(q)).toBeTruthy();

    await showPage(q, 1);
    expect(veil(q)).toBeNull();
    expect(q.getByRole("alert", { name: /stored image is temporarily unavailable/i })).toBeTruthy();
  });

  it("does not veil a page without stored evidence while the first request is still in flight", async () => {
    const q = await mount({ pageEvidence: [evidenceFor(1)] });
    await settleImage(q, 1);
    expect(veil(q)).toBeTruthy();

    await fireEvent.press(q.getByRole("button", { name: "Show receipt page 2" }));
    await fireEvent(q.getByRole("image", { name: "Receipt page 2, Source photo" }), "loadEnd");
    expect(veil(q)).toBeNull();
    expect(apiGet).toHaveBeenCalledTimes(1);
  });

  it("only clears the veil when the request for the page on screen settles during rapid page changes", async () => {
    const q = await mount();
    await settleImage(q, 1);
    await showPage(q, 2);
    await showPage(q, 3);
    await showPage(q, 2);
    expect(apiGet).toHaveBeenCalledTimes(4);
    expect(veil(q)).toBeTruthy();

    // Every superseded request is still unsettled. Settling any of them must
    // not touch page 2, which is on screen with its own fresh request.
    await resolvePending(1, "https://storage.test/stale-page-1");
    await resolvePending(3, "https://storage.test/stale-page-3");
    await resolvePending(2, "https://storage.test/stale-page-2");
    expect(veil(q)).toBeTruthy();
    expect(image(q, 2).props.source.uri).toBe("file:///two-source.jpg");

    await resolvePending(2, "https://storage.test/fresh-page-2");
    await settleImage(q, 2);
    expect(image(q, 2).props.source.uri).toBe("https://storage.test/fresh-page-2");
    expect(veil(q)).toBeNull();
    expect(pending).toHaveLength(0);
  });

  it("retries a failed stored-only page after switching away and back, and shows the retried image", async () => {
    // No local copies, so the retry control is offered and the veil belongs
    // to the stored-image request alone.
    const storedOnly = pages.map((candidate) => ({ ...candidate, uri: "", originalUri: undefined }));
    const q = await mount({ pages: storedOnly });
    await rejectPending(1);
    expect(veil(q)).toBeNull();
    expect(q.getByRole("alert", { name: /stored receipt image couldn't be opened/i })).toBeTruthy();

    await fireEvent.press(q.getByRole("button", { name: "Show receipt page 2" }));
    expect(veil(q)).toBeTruthy();

    await fireEvent.press(q.getByRole("button", { name: "Show receipt page 1" }));
    expect(veil(q)).toBeNull();
    await fireEvent.press(q.getByRole("button", { name: "Try stored image again" }));
    expect(veil(q)).toBeTruthy();
    expect(apiGet).toHaveBeenCalledTimes(3);

    await resolvePending(1, "https://storage.test/retried-page-1");
    await settleImage(q, 1);
    expect(image(q, 1).props.source.uri).toBe("https://storage.test/retried-page-1");
    expect(veil(q)).toBeNull();
  });

  it("switching variant mid-request and back re-issues the source request and ignores the stale one", async () => {
    const q = await mount();
    await settleImage(q, 1);
    const staleSource = takePending(1);
    expect(veil(q)).toBeTruthy();

    // Same page, other variant: a different key, so its own request and veil.
    await fireEvent.press(q.getByRole("tab", { name: "Enhanced color" }));
    expect(apiGet).toHaveBeenLastCalledWith("/records/receipts/77/pages/1/image/derived");
    expect(q.queryByText("Opening enhanced color…")).toBeTruthy();

    await fireEvent.press(q.getByRole("tab", { name: "Unenhanced scan" }));
    expect(apiGet).toHaveBeenCalledTimes(3);
    expect(q.queryByText("Opening unenhanced scan…")).toBeTruthy();

    await act(async () => { staleSource.resolve(storedImage(1, "https://storage.test/stale-source")); });
    expect(image(q, 1).props.source.uri).toBe("file:///one-source.jpg");
    expect(veil(q)).toBeTruthy();

    // The derived request settling cannot clear the source veil either.
    const derived = pending.find((request) => request.path.endsWith("/image/derived"))!;
    pending.splice(pending.indexOf(derived), 1);
    await act(async () => { derived.resolve({ ...storedImage(1, "https://storage.test/derived"), variant: "derived", label: "Enhanced color" }); });
    expect(veil(q)).toBeTruthy();

    await resolvePending(1, "https://storage.test/fresh-source");
    await settleImage(q, 1);
    expect(image(q, 1).props.source.uri).toBe("https://storage.test/fresh-source");
    expect(veil(q)).toBeNull();
  });

  // React 19 no longer warns on setState after unmount, so the old "no console
  // error" unmount test proved nothing. Close-and-reopen is the observable form.
  it("a request from before the viewer was closed cannot fill the reopened viewer", async () => {
    const q = await mount();
    await settleImage(q, 1);
    const beforeClose = takePending(1);
    expect(veil(q)).toBeTruthy();

    const viewer = (visible: boolean) => withTheme(
      <ReceiptEvidenceViewer
        pages={pages}
        scanId={77}
        pageEvidence={evidence}
        initialPage={0}
        visible={visible}
        onClose={vi.fn()}
      />,
    );
    await act(async () => { q.rerender(viewer(false)); });
    await act(async () => { q.rerender(viewer(true)); });
    await settleImage(q, 1);
    expect(apiGet).toHaveBeenCalledTimes(2);
    expect(veil(q)).toBeTruthy();

    await act(async () => { beforeClose.resolve(storedImage(1, "https://storage.test/before-close")); });
    expect(image(q, 1).props.source.uri).toBe("file:///one-source.jpg");
    expect(veil(q)).toBeTruthy();

    await resolvePending(1, "https://storage.test/after-reopen");
    await settleImage(q, 1);
    expect(image(q, 1).props.source.uri).toBe("https://storage.test/after-reopen");
    expect(veil(q)).toBeNull();
  });

  it("a request settling after unmount is dropped without touching the shared request log", async () => {
    // Nothing is on screen after unmount; only a zombie re-request would be visible.
    const q = await mount();
    await settleImage(q, 1);
    const request = takePending(1);
    await act(async () => { q.unmount(); });
    await act(async () => { request.resolve(storedImage(1, "https://storage.test/after-unmount")); });
    expect(apiGet).toHaveBeenCalledTimes(1);
    expect(pending).toHaveLength(0);
  });
});
