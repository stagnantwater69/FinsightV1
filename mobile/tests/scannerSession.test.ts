import { describe, expect, it } from 'vitest';
import {
  acceptPendingReceipt,
  addReceiptPage,
  captureReceipt,
  confirmScannerSession,
  discardPendingReceipt,
  createScannerSession,
  flattenScannerSession,
  normalizeInitialSections,
  removeCapturedReceipt,
  removeReceiptPage,
  reorderReceipt,
  reorderReceiptPage,
  replaceReceiptPage,
  resetScannerSession,
  restoreScannerSession,
  selectPage,
  selectReceipt,
  setScannerStage,
  switchScannerMode,
  type ScannerSession,
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
    originalMimeType: 'image/jpeg',
    processedMimeType: 'image/jpeg',
    width: 1200,
    height: 2400,
    originalWidth: 1200,
    originalHeight: 2400,
    captureSource: 'manual-camera',
    processingMode: 'original',
    quality: null,
    ...(receiptGroupId ? { receiptGroupId } : {}),
    ...overrides,
  };
}

function captured(
  mode: 'standard' | 'batch',
  receiptId: string,
  pages: ReceiptSection[],
): ScannerSession {
  const capturedSession = captureReceipt(createScannerSession([], mode), pages, receiptId);
  if (mode === 'standard') return capturedSession;
  const accepted = acceptPendingReceipt(capturedSession);
  return setScannerStage(selectReceipt(accepted, receiptId), 'review');
}

describe('scanner session restoration', () => {
  it('starts an empty Standard session in capture state', () => {
    expect(createScannerSession()).toEqual({
      mode: 'standard',
      receipts: [],
      pendingReceiptId: null,
      selectedReceiptId: null,
      selectedPageId: null,
      stage: 'capture',
    });
  });

  it('restores legacy ungrouped pages as one explicitly bounded receipt without mutating them', () => {
    const initial = [
      page('top', undefined, { captureMode: 'long' }),
      page('bottom', undefined, { captureMode: 'long' }),
    ];
    const restored = restoreScannerSession(initial, 'standard');

    expect(restored.mode).toBe('standard');
    expect(restored.stage).toBe('review');
    expect(restored.receipts).toHaveLength(1);
    expect(restored.receipts[0]!.pages.map((candidate) => candidate.localId)).toEqual(['top', 'bottom']);
    expect(restored.receipts[0]!.pages.every(
      (candidate) => candidate.receiptGroupId === restored.receipts[0]!.localReceiptId,
    )).toBe(true);
    expect(restored.receipts[0]!.pages.every((candidate) => candidate.captureMode === 'long')).toBe(true);
    expect(initial.every((candidate) => candidate.receiptGroupId === undefined)).toBe(true);
  });

  it('preserves first-seen receipt order and page order for interleaved explicit legacy groups', () => {
    const drafts = normalizeInitialSections([
      page('a-1', 'receipt-a'),
      page('b-1', 'receipt-b'),
      page('a-2', 'receipt-a'),
      page('b-2', 'receipt-b'),
    ]);

    expect(drafts.map((draft) => draft.localReceiptId)).toEqual(['receipt-a', 'receipt-b']);
    expect(drafts.map((draft) => draft.pages.map((candidate) => candidate.localId))).toEqual([
      ['a-1', 'a-2'],
      ['b-1', 'b-2'],
    ]);
  });

  it('promotes multiple restored receipt groups to Batch even when Standard was requested', () => {
    const session = createScannerSession([
      page('a', 'receipt-a'),
      page('b', 'receipt-b'),
    ], 'standard');

    expect(session.mode).toBe('batch');
    expect(session.receipts).toHaveLength(2);
    expect(session.selectedReceiptId).toBe('receipt-a');
    expect(session.selectedPageId).toBe('a');
    expect(session.stage).toBe('review');
  });
});

describe('Standard and Batch capture boundaries', () => {
  it('opens a Standard capture directly in review with one explicit receipt group', () => {
    const source = page('standard-page');
    const session = captured('standard', 'standard-receipt', [source]);

    expect(session).toMatchObject({
      mode: 'standard',
      selectedReceiptId: 'standard-receipt',
      selectedPageId: 'standard-page',
      stage: 'review',
    });
    expect(session.receipts).toHaveLength(1);
    expect(session.receipts[0]!.pages[0]).toMatchObject({
      localId: 'standard-page',
      receiptGroupId: 'standard-receipt',
    });
    expect(source.receiptGroupId).toBeUndefined();
  });

  it('refuses a second distinct receipt in Standard without changing the first', () => {
    const first = captured('standard', 'receipt-a', [page('a')]);

    expect(() => captureReceipt(first, [page('b')], 'receipt-b')).toThrow(
      /review or replace the current receipt/i,
    );
    expect(first.receipts.map((receipt) => receipt.localReceiptId)).toEqual(['receipt-a']);
  });

  it('stages every Batch capture for review before accepting the next receipt', () => {
    const empty = createScannerSession([], 'batch');
    const first = captureReceipt(empty, [page('a')], 'receipt-a');

    expect(first).toMatchObject({
      mode: 'batch',
      stage: 'review',
      pendingReceiptId: 'receipt-a',
      selectedReceiptId: 'receipt-a',
      selectedPageId: 'a',
    });
    expect(() => captureReceipt(first, [page('b')], 'receipt-b')).toThrow(/keep or discard/i);
    expect(() => confirmScannerSession(first)).toThrow(/keep or discard/i);

    const acceptedFirst = acceptPendingReceipt(first);
    expect(acceptedFirst).toMatchObject({ stage: 'capture', pendingReceiptId: null });
    const second = captureReceipt(acceptedFirst, [page('b')], 'receipt-b');
    expect(second).toMatchObject({ stage: 'review', pendingReceiptId: 'receipt-b' });
    expect(second.receipts.map((receipt) => receipt.localReceiptId)).toEqual(['receipt-a', 'receipt-b']);
    expect(second.receipts.map((receipt) => receipt.pages[0]!.receiptGroupId)).toEqual([
      'receipt-a',
      'receipt-b',
    ]);
    expect(acceptPendingReceipt(second)).toMatchObject({ stage: 'capture', pendingReceiptId: null });
  });

  it('discards only the pending Batch receipt and keeps accepted receipts in order', () => {
    const first = acceptPendingReceipt(captureReceipt(
      createScannerSession([], 'batch'),
      [page('a')],
      'receipt-a',
    ));
    const second = captureReceipt(first, [page('b')], 'receipt-b');
    const discarded = discardPendingReceipt(second);

    expect(discarded).toMatchObject({ stage: 'capture', pendingReceiptId: null });
    expect(discarded.receipts.map((receipt) => receipt.localReceiptId)).toEqual(['receipt-a']);
    expect(discardPendingReceipt(discarded)).toBe(discarded);
  });

  it('treats a repeated native callback as an identity no-op', () => {
    const section = page('callback');
    const first = captured('batch', 'receipt-a', [section]);

    expect(captureReceipt(first, [{ ...section }], 'receipt-b')).toBe(first);
  });

  it('uses source asset identity to reject the same gallery item after normalization', () => {
    const first = captured('batch', 'receipt-a', [
      page('first-copy', undefined, { sourceAssetUri: 'file:///library/receipt.png' }),
    ]);
    const duplicate = page('second-copy', undefined, {
      originalUri: 'file:///cache/normalized.jpg',
      sourceAssetUri: 'file:///library/receipt.png',
    });

    expect(captureReceipt(first, [duplicate], 'receipt-b')).toBe(first);
  });

  it('deduplicates repeated pages inside one callback while preserving first occurrence order', () => {
    const a = page('a');
    const b = page('b');
    const session = captured('batch', 'receipt-a', [a, { ...a, localId: 'duplicate-a' }, b]);

    expect(session.receipts[0]!.pages.map((candidate) => candidate.localId)).toEqual(['a', 'b']);
  });

  it('rejects empty and reused receipt group IDs', () => {
    const empty = createScannerSession([], 'batch');
    expect(() => captureReceipt(empty, [page('a')], '   ')).toThrow(/group ID cannot be empty/i);

    const first = acceptPendingReceipt(captureReceipt(empty, [page('a')], 'receipt-a'));
    expect(() => captureReceipt(first, [page('b')], 'receipt-a')).toThrow(/already in the batch/i);
  });

  it('accepts exactly the batch limit and rejects another distinct receipt', () => {
    let session = createScannerSession([], 'batch');
    for (let index = 0; index < MAX_RECEIPTS_PER_CAPTURE_BATCH; index += 1) {
      session = acceptPendingReceipt(captureReceipt(session, [page(`page-${index}`)], `receipt-${index}`));
    }

    expect(session.receipts).toHaveLength(MAX_RECEIPTS_PER_CAPTURE_BATCH);
    expect(() => captureReceipt(session, [page('overflow')], 'overflow')).toThrow(
      new RegExp(`up to ${MAX_RECEIPTS_PER_CAPTURE_BATCH} receipts`, 'i'),
    );
    expect(captureReceipt(session, [{ ...session.receipts[0]!.pages[0]! }], 'duplicate')).toBe(session);
  });
});

describe('page editing and removal', () => {
  it('adds pages to one receipt, forces its group ID, and leaves other receipts untouched', () => {
    const first = captured('batch', 'receipt-a', [page('a-1')]);
    const session = captureReceipt(first, [page('b-1')], 'receipt-b');
    const updated = addReceiptPage(session, 'receipt-a', [
      page('a-2', 'wrong-group'),
      page('a-3'),
    ]);

    expect(updated.receipts[0]!.pages.map((candidate) => candidate.localId)).toEqual([
      'a-1',
      'a-2',
      'a-3',
    ]);
    expect(updated.receipts[0]!.pages.every(
      (candidate) => candidate.receiptGroupId === 'receipt-a',
    )).toBe(true);
    expect(updated.receipts[1]).toBe(session.receipts[1]);
    expect(updated.selectedReceiptId).toBe('receipt-a');
    expect(updated.selectedPageId).toBe('a-2');
    expect(updated.stage).toBe('review');
    expect(addReceiptPage(session, 'missing', [page('unused')])).toBe(session);
  });

  it('enforces the per-receipt page ceiling without mutating the accepted pages', () => {
    const initialPages = Array.from({ length: MAX_SECTIONS }, (_, index) => page(`page-${index}`));
    const session = captured('batch', 'receipt-a', initialPages);

    expect(session.receipts[0]!.pages).toHaveLength(MAX_SECTIONS);
    expect(() => addReceiptPage(session, 'receipt-a', [page('overflow')])).toThrow(
      new RegExp(`up to ${MAX_SECTIONS} sections`, 'i'),
    );
    expect(session.receipts[0]!.pages).toHaveLength(MAX_SECTIONS);
  });

  it('replaces one page in place while preserving its stable identity and receipt boundary', () => {
    const session = captured('batch', 'receipt-a', [page('a-1'), page('a-2')]);
    const replacement = page('new-id', 'wrong-group', {
      originalUri: 'file:///retake-original.jpg',
      processedUri: 'file:///retake-processed.jpg',
      captureSource: 'gallery',
    });
    const updated = replaceReceiptPage(session, 'a-1', replacement);

    expect(updated.receipts[0]!.pages.map((candidate) => candidate.localId)).toEqual(['a-1', 'a-2']);
    expect(updated.receipts[0]!.pages[0]).toMatchObject({
      localId: 'a-1',
      receiptGroupId: 'receipt-a',
      originalUri: 'file:///retake-original.jpg',
      captureSource: 'gallery',
    });
    expect(updated.receipts[0]!.pages[1]).toBe(session.receipts[0]!.pages[1]);
    expect(session.receipts[0]!.pages[0]!.originalUri).toBe('file:///a-1-original.jpg');
  });

  it('rejects a retake that duplicates another page and a stale page target', () => {
    const session = captured('batch', 'receipt-a', [page('a-1'), page('a-2')]);
    const duplicate = page('retake', undefined, {
      originalUri: session.receipts[0]!.pages[1]!.originalUri,
    });

    expect(() => replaceReceiptPage(session, 'a-1', duplicate)).toThrow(/already in your receipt/i);
    expect(() => replaceReceiptPage(session, 'missing', page('new'))).toThrow(
      /select one photo to replace/i,
    );
  });

  it('removes a selected page and selects the nearest remaining page', () => {
    let session = captured('batch', 'receipt-a', [page('a-1'), page('a-2'), page('a-3')]);
    session = selectPage(session, 'a-2');
    session = setScannerStage(session, 'review');
    const updated = removeReceiptPage(session, 'a-2');

    expect(updated.receipts[0]!.pages.map((candidate) => candidate.localId)).toEqual(['a-1', 'a-3']);
    expect(updated.selectedPageId).toBe('a-3');
    expect(updated.selectedReceiptId).toBe('receipt-a');
    expect(updated.stage).toBe('review');
  });

  it('does not move selection when an unselected page is removed', () => {
    let session = captured('batch', 'receipt-a', [page('a-1'), page('a-2'), page('a-3')]);
    session = selectPage(session, 'a-3');
    const updated = removeReceiptPage(session, 'a-1');

    expect(updated.selectedPageId).toBe('a-3');
    expect(updated.selectedReceiptId).toBe('receipt-a');
  });

  it('removes the receipt when its last page is deleted and returns an empty session to capture', () => {
    const session = captured('standard', 'receipt-a', [page('a')]);
    const updated = removeReceiptPage(session, 'a');

    expect(updated).toEqual({
      mode: 'standard',
      receipts: [],
      pendingReceiptId: null,
      selectedReceiptId: null,
      selectedPageId: null,
      stage: 'capture',
    });
    expect(removeReceiptPage(updated, 'missing')).toBe(updated);
  });

  it('selects the next receipt after removing the selected draft and preserves another selection', () => {
    let session = captured('batch', 'receipt-a', [page('a')]);
    session = acceptPendingReceipt(captureReceipt(session, [page('b')], 'receipt-b'));
    session = captureReceipt(session, [page('c')], 'receipt-c');
    session = selectReceipt(session, 'receipt-b');

    const removedSelected = removeCapturedReceipt(session, 'receipt-b');
    expect(removedSelected.receipts.map((receipt) => receipt.localReceiptId)).toEqual([
      'receipt-a',
      'receipt-c',
    ]);
    expect(removedSelected.selectedReceiptId).toBe('receipt-c');
    expect(removedSelected.selectedPageId).toBe('c');

    const selectedA = selectReceipt(removedSelected, 'receipt-a');
    const removedC = removeCapturedReceipt(selectedA, 'receipt-c');
    expect(removedC.selectedReceiptId).toBe('receipt-a');
    expect(removedC.selectedPageId).toBe('a');
    expect(removeCapturedReceipt(removedC, 'missing')).toBe(removedC);
  });
});

describe('ordering, selection, and stages', () => {
  it('reorders whole Batch receipts without changing their page membership', () => {
    let session = captured('batch', 'receipt-a', [page('a-1'), page('a-2')]);
    session = captureReceipt(session, [page('b')], 'receipt-b');
    const reordered = reorderReceipt(session, 'receipt-b', -1);

    expect(reordered.receipts.map((receipt) => receipt.localReceiptId)).toEqual([
      'receipt-b',
      'receipt-a',
    ]);
    expect(reordered.receipts[1]!.pages.map((candidate) => candidate.localId)).toEqual(['a-1', 'a-2']);
    expect(reorderReceipt(reordered, 'receipt-b', -1)).toBe(reordered);
    expect(reorderReceipt(reordered, 'missing', 1)).toBe(reordered);
  });

  it('does not reorder a Standard receipt', () => {
    const session = captured('standard', 'receipt-a', [page('a')]);
    expect(reorderReceipt(session, 'receipt-a', 1)).toBe(session);
  });

  it('reorders pages only inside their owning receipt and treats invalid moves as no-ops', () => {
    let session = captured('batch', 'receipt-a', [page('a-1'), page('a-2')]);
    session = captureReceipt(session, [page('b-1'), page('b-2')], 'receipt-b');
    const reordered = reorderReceiptPage(session, 'a-2', -1);

    expect(reordered.receipts[0]!.pages.map((candidate) => candidate.localId)).toEqual(['a-2', 'a-1']);
    expect(reordered.receipts[1]!.pages.map((candidate) => candidate.localId)).toEqual(['b-1', 'b-2']);
    expect(reorderReceiptPage(reordered, 'a-2', -1)).toBe(reordered);
    expect(reorderReceiptPage(reordered, 'missing', 1)).toBe(reordered);
  });

  it('moves selection with the chosen receipt or page and exits page-edit stages safely', () => {
    let session = captured('batch', 'receipt-a', [page('a')]);
    session = captureReceipt(session, [page('b-1'), page('b-2')], 'receipt-b');
    session = selectPage(session, 'b-2');
    session = setScannerStage(session, 'crop');

    const selectedA = selectReceipt(session, 'receipt-a');
    expect(selectedA).toMatchObject({
      selectedReceiptId: 'receipt-a',
      selectedPageId: 'a',
      stage: 'review',
    });

    const selectedB2 = selectPage(setScannerStage(selectedA, 'filter'), 'b-2');
    expect(selectedB2).toMatchObject({
      selectedReceiptId: 'receipt-b',
      selectedPageId: 'b-2',
      stage: 'review',
    });
    expect(selectPage(selectedB2, 'missing')).toBe(selectedB2);
    expect(selectReceipt(selectedB2, 'missing')).toBe(selectedB2);
  });

  it('requires a selected page for edit stages and never reviews an empty session', () => {
    const empty = createScannerSession([], 'batch');
    expect(setScannerStage(empty, 'review')).toBe(empty);
    expect(setScannerStage(empty, 'crop')).toBe(empty);

    const session = captured('batch', 'receipt-a', [page('a')]);
    const withoutSelection = selectPage(session, null);
    expect(setScannerStage(withoutSelection, 'filter')).toBe(withoutSelection);
    expect(setScannerStage(session, 'retake').stage).toBe('retake');
    expect(setScannerStage(session, session.stage)).toBe(session);
    expect(selectReceipt(setScannerStage(session, 'crop'), null)).toMatchObject({
      selectedReceiptId: null,
      selectedPageId: null,
      stage: 'review',
    });
  });
});

describe('mode changes, reset, and confirmation', () => {
  it('changes only an empty session mode and preserves every non-empty session unchanged', () => {
    const empty = createScannerSession();
    const batch = switchScannerMode(empty, 'batch');
    expect(batch).toEqual({ ...empty, mode: 'batch' });
    expect(switchScannerMode(batch, 'batch')).toBe(batch);

    const standard = captured('standard', 'standard-receipt', [page('standard-page')]);
    expect(switchScannerMode(standard, 'batch')).toBe(standard);

    const oneReceiptBatch = captured('batch', 'receipt-a', [page('a')]);
    expect(switchScannerMode(oneReceiptBatch, 'standard')).toBe(oneReceiptBatch);

    let populated = captured('batch', 'receipt-a', [page('a')]);
    populated = captureReceipt(populated, [page('b')], 'receipt-b');
    expect(switchScannerMode(populated, 'standard')).toBe(populated);
  });

  it('resets through an explicit discard while preserving or replacing the mode', () => {
    const session = captured('batch', 'receipt-a', [page('a')]);

    expect(resetScannerSession(session)).toEqual({
      mode: 'batch',
      receipts: [],
      pendingReceiptId: null,
      selectedReceiptId: null,
      selectedPageId: null,
      stage: 'capture',
    });
    expect(resetScannerSession(session, 'standard')).toEqual({
      mode: 'standard',
      receipts: [],
      pendingReceiptId: null,
      selectedReceiptId: null,
      selectedPageId: null,
      stage: 'capture',
    });
  });

  it('flattens confirmation in receipt and page order with explicit boundaries', () => {
    let session = captured('batch', 'receipt-a', [page('a-1'), page('a-2')]);
    session = acceptPendingReceipt(captureReceipt(session, [page('b')], 'receipt-b'));
    session = reorderReceipt(session, 'receipt-b', -1);
    const flattened = flattenScannerSession(session);

    expect(flattened.map((candidate) => [candidate.localId, candidate.receiptGroupId])).toEqual([
      ['b', 'receipt-b'],
      ['a-1', 'receipt-a'],
      ['a-2', 'receipt-a'],
    ]);
    expect(confirmScannerSession(session)).toEqual(flattened);
    expect(flattened[0]).not.toBe(session.receipts[0]!.pages[0]);
  });
});
