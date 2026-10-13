import { describe, expect, it } from 'vitest';
import {
  captureReceipt,
  confirmScannerSession,
  removeReceiptPage,
  restoreScannerSession,
  selectPage,
} from '../src/components/receipt-camera/scannerSession';
import { MAX_SECTIONS, type ReceiptSection } from '../src/lib/receiptCapture';
import { MAX_RECEIPTS_PER_CAPTURE_BATCH } from '../src/lib/receiptGrouping';

function page(
  id: string,
  receiptGroupId?: string,
  overrides: Partial<ReceiptSection> = {},
): ReceiptSection {
  return {
    localId: id,
    originalUri: `file:///${id}-original.jpg`,
    processedUri: `file:///${id}-processed.jpg`,
    width: 1200,
    height: 2400,
    captureSource: 'gallery',
    processingMode: 'original',
    quality: null,
    ...(receiptGroupId === undefined ? {} : { receiptGroupId }),
    ...overrides,
  };
}

describe('scanner session recovery hardening', () => {
  it('rejects restored receipts and batches that exceed their hard limits', () => {
    const tooManyPages = Array.from(
      { length: MAX_SECTIONS + 1 },
      (_, index) => page(`page-${index}`, 'receipt-a'),
    );
    const tooManyReceipts = Array.from(
      { length: MAX_RECEIPTS_PER_CAPTURE_BATCH + 1 },
      (_, index) => page(`page-${index}`, `receipt-${index}`),
    );

    expect(() => restoreScannerSession(tooManyPages)).toThrow(
      new RegExp(`up to ${MAX_SECTIONS} sections`, 'i'),
    );
    expect(() => restoreScannerSession(tooManyReceipts)).toThrow(
      new RegExp(`up to ${MAX_RECEIPTS_PER_CAPTURE_BATCH} receipts`, 'i'),
    );
  });

  it('canonicalizes restored group IDs and never confirms a blank boundary', () => {
    const session = restoreScannerSession([
      page('legacy-a', '   '),
      page('legacy-b'),
      page('explicit-a', ' receipt-a '),
      page('explicit-b', 'receipt-a'),
    ]);

    expect(session.mode).toBe('batch');
    expect(session.receipts).toHaveLength(2);
    expect(session.receipts[1]!.localReceiptId).toBe('receipt-a');
    expect(session.receipts[1]!.pages.map((candidate) => candidate.localId)).toEqual([
      'explicit-a',
      'explicit-b',
    ]);
    expect(confirmScannerSession(session).every(
      (candidate) => Boolean(candidate.receiptGroupId?.trim()),
    )).toBe(true);
  });

  it('renames duplicate restored page IDs before selection or deletion', () => {
    const initial = [page('same', 'receipt-a'), page('same', 'receipt-b')];
    let session = restoreScannerSession(initial);

    expect(session.receipts.map((receipt) => receipt.pages[0]!.localId)).toEqual(['same', 'same-2']);
    expect(initial.map((candidate) => candidate.localId)).toEqual(['same', 'same']);
    session = selectPage(session, 'same-2');
    expect(session.selectedReceiptId).toBe('receipt-b');

    const updated = removeReceiptPage(session, 'same-2');
    expect(updated.receipts.map((receipt) => receipt.localReceiptId)).toEqual(['receipt-a']);
    expect(updated.receipts[0]!.pages[0]!.localId).toBe('same');
  });

  it('rejects duplicates when source and original URI identities overlap asymmetrically', () => {
    const originalLibraryAsset = page('original-library-asset', undefined, {
      originalUri: 'file:///library/receipt.png',
    });
    const normalizedCopy = page('normalized-copy', undefined, {
      originalUri: 'file:///cache/normalized.jpg',
      sourceAssetUri: 'file:///library/receipt.png',
    });

    const firstOriginal = captureReceipt(
      restoreScannerSession([], 'batch'),
      [originalLibraryAsset],
      'receipt-a',
    );
    expect(captureReceipt(firstOriginal, [normalizedCopy], 'receipt-b')).toBe(firstOriginal);

    const firstNormalized = captureReceipt(
      restoreScannerSession([], 'batch'),
      [normalizedCopy],
      'receipt-a',
    );
    expect(captureReceipt(firstNormalized, [originalLibraryAsset], 'receipt-b')).toBe(firstNormalized);
  });
});
