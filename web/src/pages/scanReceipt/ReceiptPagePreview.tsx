import { useEffect, useRef, useState } from "react";
import { api } from "../../lib/api";
import { receiptPageImageFromResponse } from "./receiptPageImage";
import type {
  ReceiptPageEvidence,
  ReceiptPageImage,
  ReceiptPageProcessing,
  ReceiptPageQuality,
} from "./types";

const MIN_ZOOM = 50;
const MAX_ZOOM = 200;
const ZOOM_STEP = 25;

interface ImageDimensions {
  width: number;
  height: number;
}

function validDimensions(width: number | null | undefined, height: number | null | undefined): ImageDimensions | null {
  return width && height && width > 0 && height > 0 ? { width, height } : null;
}

function ReceiptImageCanvas({
  url,
  alt,
  rotation,
  zoom,
  imageDimensions,
  onDimensions,
  onError,
}: {
  url: string;
  alt: string;
  rotation: number;
  zoom: number;
  imageDimensions: ImageDimensions | null;
  onDimensions: (width: number, height: number) => void;
  onError: () => void;
}) {
  const measured = imageDimensions ?? { width: 1, height: 1 };
  const quarterTurn = rotation % 180 !== 0;
  const aspect = measured.height / measured.width;
  const canvasWidth = (quarterTurn ? aspect : 1) * zoom;
  const imageWidth = quarterTurn ? 100 / aspect : 100;
  const imagePosition = rotation === 90
    ? { left: "100%", top: "0" }
    : rotation === 180
      ? { left: "100%", top: "100%" }
      : rotation === 270
        ? { left: "0", top: "100%" }
        : { left: "0", top: "0" };

  return (
    <div
      className="relative shrink-0"
      style={{
        width: `${canvasWidth}%`,
        aspectRatio: quarterTurn
          ? `${measured.height} / ${measured.width}`
          : `${measured.width} / ${measured.height}`,
        marginInline: canvasWidth <= 100 ? "auto" : 0,
      }}
    >
      <img
        src={url}
        alt={alt}
        onLoad={(event) => {
          const { naturalWidth, naturalHeight } = event.currentTarget;
          if (naturalWidth > 0 && naturalHeight > 0) onDimensions(naturalWidth, naturalHeight);
        }}
        onError={onError}
        className="absolute h-auto max-w-none object-contain transition-transform duration-200 motion-reduce:transition-none"
        style={{
          width: `${imageWidth}%`,
          left: imagePosition.left,
          top: imagePosition.top,
          transformOrigin: "top left",
          transform: `rotate(${rotation}deg)`,
        }}
      />
    </div>
  );
}

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
  const [rotationByPage, setRotationByPage] = useState<Record<number, number>>({});
  const [zoomByPage, setZoomByPage] = useState<Record<number, number>>({});
  const [imageDimensions, setImageDimensions] = useState<Record<string, ImageDimensions>>({});
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
    setRotationByPage({});
    setZoomByPage({});
    setImageDimensions({});
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
  const selectedRotation = rotationByPage[pageNumber] ?? 0;
  const selectedZoom = zoomByPage[pageNumber] ?? 100;
  const imageKey = `${pageNumber}:${selectedVariant}`;
  const metadataDimensions = selectedVariant === "derived"
    ? validDimensions(derivedImage?.width, derivedImage?.height)
    : validDimensions(sourceImage?.width ?? evidence?.source.width, sourceImage?.height ?? evidence?.source.height);
  const selectedDimensions = imageDimensions[imageKey] ?? metadataDimensions;

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

  function rotateSelectedPage(delta: -90 | 90) {
    setRotationByPage((current) => ({
      ...current,
      [pageNumber]: (((current[pageNumber] ?? 0) + delta) % 360 + 360) % 360,
    }));
  }

  function changeZoom(delta: number) {
    setZoomByPage((current) => ({
      ...current,
      [pageNumber]: Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, (current[pageNumber] ?? 100) + delta)),
    }));
  }

  function resetZoom() {
    setZoomByPage((current) => ({ ...current, [pageNumber]: 100 }));
  }

  function rememberImageDimensions(width: number, height: number) {
    setImageDimensions((current) => {
      const existing = current[imageKey];
      if (existing?.width === width && existing.height === height) return current;
      return { ...current, [imageKey]: { width, height } };
    });
  }

  return (
    <section aria-label="Receipt page evidence" className="min-w-0">
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

      <div id="receipt-page-panel" role="tabpanel" aria-label={pageLabel} tabIndex={0} className="min-w-0">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          {evidence?.derived ? (
            <div className="flex flex-wrap gap-2" role="group" aria-label={`Image version for page ${selectedPage + 1}`}>
              <button
                type="button"
                aria-pressed={selectedVariant === "source"}
                onClick={showSource}
                className={`tap-inline min-h-tap rounded-lg px-3 py-2 text-xs font-semibold transition ${
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
                className={`tap-inline min-h-tap rounded-lg px-3 py-2 text-xs font-semibold transition disabled:opacity-60 ${
                  selectedVariant === "derived"
                    ? "bg-brand-700 text-white"
                    : "bg-paper-100 text-ink-600 hover:bg-paper-200"
                }`}
              >
                {derivedLoading ? "Loading adjusted copy…" : evidence.derived.label}
              </button>
            </div>
          ) : <span />}
          {selectedUrl ? (
            <div className="flex flex-wrap items-center gap-1" role="group" aria-label={`Controls for ${pageLabel.toLowerCase()}`}>
              <button
                type="button"
                onClick={() => changeZoom(-ZOOM_STEP)}
                disabled={selectedZoom <= MIN_ZOOM}
                className="tap-inline min-h-tap rounded-lg px-3 py-2 text-xs font-semibold text-ink-600 transition hover:bg-paper-100 hover:text-ink-900 disabled:opacity-40"
              >
                Zoom out
              </button>
              <button
                type="button"
                onClick={resetZoom}
                aria-label={`Reset receipt zoom to 100 percent. Current zoom ${selectedZoom} percent.`}
                className="tap-inline min-h-tap min-w-16 rounded-lg px-2 py-2 text-xs font-semibold tabular-nums text-ink-600 transition hover:bg-paper-100 hover:text-ink-900"
              >
                {selectedZoom}%
              </button>
              <button
                type="button"
                onClick={() => changeZoom(ZOOM_STEP)}
                disabled={selectedZoom >= MAX_ZOOM}
                className="tap-inline min-h-tap rounded-lg px-3 py-2 text-xs font-semibold text-ink-600 transition hover:bg-paper-100 hover:text-ink-900 disabled:opacity-40"
              >
                Zoom in
              </button>
              <button
                type="button"
                onClick={() => rotateSelectedPage(-90)}
                className="tap-inline min-h-tap rounded-lg px-3 py-2 text-xs font-semibold text-ink-600 transition hover:bg-paper-100 hover:text-ink-900"
              >
                Rotate left
              </button>
              <button
                type="button"
                onClick={() => rotateSelectedPage(90)}
                className="tap-inline min-h-tap rounded-lg px-3 py-2 text-xs font-semibold text-ink-600 transition hover:bg-paper-100 hover:text-ink-900"
              >
                Rotate right
              </button>
              <button
                type="button"
                onClick={() => zoomRef.current?.showModal()}
                aria-label={`Enlarge ${variantLabel.toLowerCase()}, receipt ${pageLabel.toLowerCase()}`}
                className="tap-inline min-h-tap rounded-lg px-3 py-2 text-xs font-semibold text-tone-brand transition hover:bg-tint-brand"
              >
                Enlarge
              </button>
            </div>
          ) : null}
          <span className="sr-only" aria-live="polite">
            {pageLabel} orientation: {selectedRotation} degrees. Zoom: {selectedZoom} percent.
          </span>
        </div>

        {selectedUrl ? (
          <div
            role="region"
            tabIndex={0}
            aria-label={`Scrollable ${variantLabel.toLowerCase()}, receipt ${pageLabel.toLowerCase()}`}
            className="scroll-slim max-h-[70vh] min-h-52 w-full touch-auto overflow-auto rounded-xl border border-paper-200 bg-paper-100 p-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600"
          >
            <ReceiptImageCanvas
              url={selectedUrl}
              alt={`${variantLabel}, receipt ${pageLabel.toLowerCase()}`}
              rotation={selectedRotation}
              zoom={selectedZoom}
              imageDimensions={selectedDimensions}
              onDimensions={rememberImageDimensions}
              onError={handleSelectedImageError}
            />
          </div>
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
          <p className="w-full text-ink-500">Use the zoom controls or Enlarge to inspect small print.</p>
        </div>
      </div>

      {selectedUrl ? (
        <dialog
          ref={zoomRef}
          onClick={(event) => {
            if (event.target === event.currentTarget) zoomRef.current?.close();
          }}
          className="confirm-dialog max-h-[92vh] w-[min(60rem,calc(100vw-2rem))] overflow-hidden rounded-2xl border border-paper-200 bg-paper p-3"
          aria-label={`Enlarged ${variantLabel.toLowerCase()}, receipt ${pageLabel.toLowerCase()}`}
        >
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-semibold text-ink-800">
              {pageLabel} at {selectedZoom}%
            </p>
            <div className="flex items-center gap-1" role="group" aria-label="Enlarged receipt zoom">
              <button
                type="button"
                onClick={() => changeZoom(-ZOOM_STEP)}
                disabled={selectedZoom <= MIN_ZOOM}
                className="tap-inline min-h-tap rounded-lg px-3 py-2 text-xs font-semibold text-ink-600 transition hover:bg-paper-100 disabled:opacity-40"
              >
                Zoom out
              </button>
              <button
                type="button"
                onClick={resetZoom}
                aria-label={`Reset enlarged receipt zoom to 100 percent. Current zoom ${selectedZoom} percent.`}
                className="tap-inline min-h-tap min-w-16 rounded-lg px-2 py-2 text-xs font-semibold tabular-nums text-ink-600 transition hover:bg-paper-100"
              >
                {selectedZoom}%
              </button>
              <button
                type="button"
                onClick={() => changeZoom(ZOOM_STEP)}
                disabled={selectedZoom >= MAX_ZOOM}
                className="tap-inline min-h-tap rounded-lg px-3 py-2 text-xs font-semibold text-ink-600 transition hover:bg-paper-100 disabled:opacity-40"
              >
                Zoom in
              </button>
            </div>
            <button
              type="button"
              onClick={() => zoomRef.current?.close()}
              className="tap-inline rounded-lg px-3 py-2 text-sm font-semibold text-tone-brand hover:bg-tint-brand"
            >
              Close enlarged page
            </button>
          </div>
          <div
            role="region"
            tabIndex={0}
            aria-label={`Scrollable enlarged ${variantLabel.toLowerCase()}, receipt ${pageLabel.toLowerCase()}`}
            className="scroll-slim max-h-[calc(92vh-5.5rem)] min-h-52 touch-auto overflow-auto rounded-xl bg-paper-100 p-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600"
          >
            <ReceiptImageCanvas
              url={selectedUrl}
              alt={`${variantLabel}, receipt ${pageLabel.toLowerCase()}, enlarged`}
              rotation={selectedRotation}
              zoom={selectedZoom}
              imageDimensions={selectedDimensions}
              onDimensions={rememberImageDimensions}
              onError={handleSelectedImageError}
            />
          </div>
        </dialog>
      ) : null}
    </section>
  );
}
