import { useEffect, useRef, useState } from "react";
import { api } from "../../lib/api";
import { receiptPageImageFromResponse } from "./receiptPageImage";
import type {
  ReceiptPageEvidence,
  ReceiptPageImage,
  ReceiptPageProcessing,
  ReceiptPageQuality,
} from "./types";

interface ReceiptPagePreviewProps {
  scanId: number;
  files: File[];
  pageEvidence?: ReceiptPageEvidence[];
  pageProcessing?: ReceiptPageProcessing[];
  pageQualities?: ReceiptPageQuality[];
}

function processingNote(
  evidence: ReceiptPageEvidence | undefined,
  processing: ReceiptPageProcessing | undefined,
): string {
  if (evidence?.ocrInput === "derived" && evidence.derived) {
    return `OCR used the ${evidence.derived.label.toLowerCase()} copy. Your source image is retained.`;
  }
  if (evidence?.ocrInput === "source") {
    return evidence.source.label === "Composite source"
      ? "OCR used the composite source."
      : "OCR used the source image.";
  }
  if (processing?.source === "processed") {
    return "OCR used an adjusted copy. Your source photo is retained.";
  }
  if (processing?.source === "original") {
    return processing.hasProcessedVariant
      ? "OCR used the source photo. An adjusted copy is also retained."
      : "OCR used the source photo.";
  }
  return "Viewing the source photo you uploaded.";
}

function dimensions(width: number | null, height: number | null): string {
  return width && height ? `, ${width} × ${height}` : "";
}

export function ReceiptPagePreview({
  scanId,
  files,
  pageEvidence,
  pageProcessing,
  pageQualities,
}: ReceiptPagePreviewProps) {
  const [pageUrls, setPageUrls] = useState<string[]>([]);
  const [selectedPage, setSelectedPage] = useState(0);
  const [selectedVariant, setSelectedVariant] = useState<"source" | "derived">("source");
  const [sourceImages, setSourceImages] = useState<Record<number, ReceiptPageImage>>({});
  const [sourceLoadingPage, setSourceLoadingPage] = useState<number | null>(null);
  const [sourceErrors, setSourceErrors] = useState<Record<number, string>>({});
  const [derivedImages, setDerivedImages] = useState<Record<number, ReceiptPageImage>>({});
  const [derivedLoading, setDerivedLoading] = useState(false);
  const [derivedError, setDerivedError] = useState<string | null>(null);
  const zoomRef = useRef<HTMLDialogElement>(null);
  const pageTabs = useRef<Array<HTMLButtonElement | null>>([]);
  const sourceRequest = useRef(0);
  const derivedRequest = useRef(0);

  useEffect(() => {
    const urls = files.map((file) => URL.createObjectURL(file));
    setPageUrls(urls);
    setSelectedPage(0);
    setSelectedVariant("source");
    setSourceImages({});
    setSourceErrors({});
    setDerivedImages({});
    setDerivedError(null);
    return () => {
      derivedRequest.current += 1;
      sourceRequest.current += 1;
      urls.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [files, scanId]);

  const pageCount = Math.max(
    pageUrls.length,
    pageEvidence?.length ?? 0,
    pageProcessing?.length ?? 0,
    pageQualities?.length ?? 0,
  );
  const evidence = pageEvidence?.[selectedPage];
  const pageNumber = selectedPage + 1;
  const sourceImage = sourceImages[pageNumber];
  const sourceUrl = pageUrls[selectedPage] ?? sourceImage?.url;
  const derivedImage = derivedImages[selectedPage + 1];
  const selectedUrl = selectedVariant === "derived" && derivedImage ? derivedImage.url : sourceUrl;
  const variantLabel = selectedVariant === "derived" && evidence?.derived
    ? evidence.derived.label
    : evidence?.source.label ?? "Source";
  const selectedQuality = pageQualities?.[selectedPage];
  const pageLabel = `Page ${selectedPage + 1} of ${pageCount}`;

  useEffect(() => {
    if (
      pageCount === 0 ||
      pageUrls[selectedPage] ||
      sourceImages[pageNumber] ||
      sourceErrors[pageNumber] ||
      !evidence
    ) return;

    const request = ++sourceRequest.current;
    setSourceLoadingPage(pageNumber);
    void api.get<ReceiptPageImage>(
      `/records/receipts/${scanId}/pages/${pageNumber}/image/source`,
    ).then(({ data }) => {
      if (request !== sourceRequest.current) return;
      const image = receiptPageImageFromResponse(data, { pageNumber, variant: "source" });
      if (!image) throw new Error("Receipt image response did not match the requested page.");
      setSourceImages((current) => ({ ...current, [pageNumber]: image }));
    }).catch(() => {
      if (request !== sourceRequest.current) return;
      setSourceErrors((current) => ({
        ...current,
        [pageNumber]: "The source image could not be loaded. Try again.",
      }));
    }).finally(() => {
      if (request === sourceRequest.current) setSourceLoadingPage(null);
    });
  }, [evidence, pageCount, pageNumber, pageUrls, scanId, selectedPage, sourceErrors, sourceImages]);

  if (pageCount === 0) return null;

  function selectPage(index: number) {
    const next = (index + pageCount) % pageCount;
    derivedRequest.current += 1;
    sourceRequest.current += 1;
    setSelectedPage(next);
    setSelectedVariant("source");
    setSourceLoadingPage(null);
    setDerivedLoading(false);
    setDerivedError(null);
    return next;
  }

  function movePageFocus(index: number) {
    const next = selectPage(index);
    pageTabs.current[next]?.focus();
  }

  function showSource() {
    derivedRequest.current += 1;
    setDerivedLoading(false);
    setSelectedVariant("source");
    setDerivedError(null);
  }

  async function showDerived() {
    if (!evidence?.derived || derivedLoading) return;
    const pageNumber = selectedPage + 1;
    if (derivedImages[pageNumber]) {
      setSelectedVariant("derived");
      setDerivedError(null);
      return;
    }

    const request = ++derivedRequest.current;
    setDerivedLoading(true);
    setDerivedError(null);
    try {
      const { data } = await api.get<ReceiptPageImage>(
        `/records/receipts/${scanId}/pages/${pageNumber}/image/derived`,
      );
      if (request !== derivedRequest.current) return;
      const image = receiptPageImageFromResponse(data, { pageNumber, variant: "derived" });
      if (!image) throw new Error("Receipt image response did not match the requested page.");
      setDerivedImages((current) => ({ ...current, [pageNumber]: image }));
      setSelectedVariant("derived");
    } catch {
      if (request === derivedRequest.current) {
        setSelectedVariant("source");
        setDerivedError("The adjusted copy could not be loaded. The source image is still available. Try again.");
      }
    } finally {
      if (request === derivedRequest.current) setDerivedLoading(false);
    }
  }

  function handleSelectedImageError() {
    if (selectedVariant === "derived") {
      setDerivedImages((current) => {
        const next = { ...current };
        delete next[pageNumber];
        return next;
      });
      setSelectedVariant("source");
      setDerivedError("The adjusted copy expired or could not be displayed. The source image is still available. Try again.");
      return;
    }
    if (!pageUrls[selectedPage]) {
      setSourceImages((current) => {
        const next = { ...current };
        delete next[pageNumber];
        return next;
      });
      setSourceErrors((current) => ({
        ...current,
        [pageNumber]: "The source image expired or could not be displayed. Try again.",
      }));
    }
  }

  return (
    <section aria-label="Receipt page evidence">
      {pageCount > 1 ? (
        <div className="mb-3">
          <div
            role="tablist"
            aria-label="Receipt pages"
            aria-orientation="horizontal"
            className="flex gap-2 overflow-x-auto pb-1"
          >
            {Array.from({ length: pageCount }, (_, index) => {
              const url = pageUrls[index] ?? sourceImages[index + 1]?.url;
              const quality = pageQualities?.[index];
              const qualityWarning = quality?.tooBlurredToTrust === true || quality?.tooSmallToRead === true;
              const selected = selectedPage === index;
              return (
                <button
                  key={index + 1}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  aria-controls="receipt-page-panel"
                  tabIndex={selected ? 0 : -1}
                  aria-label={`View page ${index + 1} of ${pageCount}${qualityWarning ? ", quality warning" : ""}`}
                  onClick={() => {
                    selectPage(index);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "ArrowRight") {
                      event.preventDefault();
                      movePageFocus(index + 1);
                    } else if (event.key === "ArrowLeft") {
                      event.preventDefault();
                      movePageFocus(index - 1);
                    } else if (event.key === "Home") {
                      event.preventDefault();
                      movePageFocus(0);
                    } else if (event.key === "End") {
                      event.preventDefault();
                      movePageFocus(pageCount - 1);
                    }
                  }}
                  ref={(node) => {
                    pageTabs.current[index] = node;
                  }}
                  className={`tap min-w-20 shrink-0 overflow-hidden rounded-xl text-left transition ${
                    selected
                      ? "bg-tint-brand text-tone-brand ring-2 ring-edge-brand"
                      : "bg-paper-100 text-ink-600 ring-1 ring-paper-200 hover:bg-paper-200"
                  }`}
                >
                  {url ? (
                    <img src={url} alt="" className="h-14 w-full object-cover" />
                  ) : (
                    <span aria-hidden className="block h-14 bg-paper-200" />
                  )}
                  <span className="block px-2 py-1 text-xs font-semibold">
                    Page {index + 1}
                    {qualityWarning ? <span className="sr-only">, quality warning</span> : null}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      ) : null}

      <div id="receipt-page-panel" role="tabpanel" aria-label={pageLabel} tabIndex={0}>
        {evidence?.derived ? (
          <div className="mb-2 flex flex-wrap gap-2" role="group" aria-label={`Image version for page ${selectedPage + 1}`}>
            <button
              type="button"
              aria-pressed={selectedVariant === "source"}
              onClick={showSource}
              className={`tap-inline rounded-lg px-3 py-2 text-xs font-semibold transition ${
                selectedVariant === "source"
                  ? "bg-brand-700 text-white"
                  : "bg-paper-100 text-ink-600 hover:bg-paper-200"
              }`}
            >
              {evidence.source.label}
            </button>
            <button
              type="button"
              aria-pressed={selectedVariant === "derived"}
              onClick={showDerived}
              disabled={derivedLoading}
              className={`tap-inline rounded-lg px-3 py-2 text-xs font-semibold transition disabled:opacity-60 ${
                selectedVariant === "derived"
                  ? "bg-brand-700 text-white"
                  : "bg-paper-100 text-ink-600 hover:bg-paper-200"
              }`}
            >
              {derivedLoading ? "Loading adjusted copy…" : evidence.derived.label}
            </button>
          </div>
        ) : null}

        {selectedUrl ? (
          <button
            type="button"
            onClick={() => zoomRef.current?.showModal()}
            className="block w-full cursor-zoom-in overflow-hidden rounded-xl border border-paper-200 bg-paper-100"
            aria-label={`Enlarge ${variantLabel.toLowerCase()}, receipt ${pageLabel.toLowerCase()}`}
          >
            <img
              src={selectedUrl}
              alt={`${variantLabel}, receipt ${pageLabel.toLowerCase()}`}
              onError={handleSelectedImageError}
              className="mx-auto max-h-[70vh] w-full object-contain"
            />
          </button>
        ) : (
          <div className="flex min-h-52 items-center justify-center rounded-xl border border-paper-200 bg-paper-100 p-4 text-center text-sm text-ink-600">
            {sourceLoadingPage === pageNumber ? (
              <p role="status">Loading source image…</p>
            ) : (
              <div>
                <p>{sourceErrors[pageNumber] ?? "The source image is not available."}</p>
                {evidence ? (
                  <button
                    type="button"
                    onClick={() => setSourceErrors((current) => {
                      const next = { ...current };
                      delete next[pageNumber];
                      return next;
                    })}
                    className="tap-inline mt-2 rounded-lg px-3 py-2 font-semibold text-tone-brand hover:bg-tint-brand"
                  >
                    Try loading source again
                  </button>
                ) : null}
              </div>
            )}
          </div>
        )}

        <div className="mt-2 flex flex-wrap items-start justify-between gap-x-3 gap-y-1 text-xs">
          <p className="font-semibold text-ink-700">{pageLabel}</p>
          {selectedQuality?.tooBlurredToTrust || selectedQuality?.tooSmallToRead ? (
            <p className="font-semibold text-tone-accent">
              {selectedQuality.tooBlurredToTrust
                ? "Quality warning: check this page closely."
                : "Resolution warning: check small print closely."}
            </p>
          ) : null}
          <p className="w-full text-ink-500">
            Viewing {variantLabel.toLowerCase()}
            {selectedVariant === "derived" && derivedImage
              ? dimensions(derivedImage.width, derivedImage.height)
              : dimensions(evidence?.source.width ?? null, evidence?.source.height ?? null)}.
          </p>
          <p className="w-full text-ink-500">
            {processingNote(evidence, pageProcessing?.[selectedPage])}
          </p>
          {derivedError ? <p className="w-full font-medium text-tone-danger" role="alert">{derivedError}</p> : null}
          <p className="w-full text-ink-500">Select the photo to enlarge it.</p>
        </div>
      </div>

      {selectedUrl ? (
        <dialog
          ref={zoomRef}
          onClick={(event) => {
            if (event.target === event.currentTarget) zoomRef.current?.close();
          }}
          className="confirm-dialog max-h-[92vh] w-[min(60rem,calc(100vw-2rem))] rounded-2xl border border-paper-200 bg-paper p-2"
          aria-label={`Enlarged ${variantLabel.toLowerCase()}, receipt ${pageLabel.toLowerCase()}`}
        >
          <img
            src={selectedUrl}
            alt={`${variantLabel}, receipt ${pageLabel.toLowerCase()}, enlarged`}
            onError={handleSelectedImageError}
            className="w-full object-contain"
          />
          <button
            type="button"
            onClick={() => zoomRef.current?.close()}
            className="tap-inline mx-auto mt-2 block rounded-lg px-3 py-2 text-sm font-semibold text-tone-brand hover:bg-tint-brand"
          >
            Close enlarged page
          </button>
        </dialog>
      ) : null}
    </section>
  );
}
