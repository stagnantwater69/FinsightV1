import {
  MAX_SECTIONS,
  moveSection,
  type ReceiptSection,
} from '../../lib/receiptCapture';
import {
  MAX_RECEIPTS_PER_CAPTURE_BATCH,
  groupReceiptMembers,
  makeReceiptGroupsExplicit,
  newReceiptGroupId,
} from '../../lib/receiptGrouping';
import {
  addSessionSections,
  moveSessionSection,
} from '../../lib/receiptCameraSession';

export type ScannerSessionMode = 'standard' | 'batch';

export type ScannerSessionStage =
  | 'capture'
  | 'review'
  | 'crop'
  | 'filter'
  | 'retake';

export interface CapturedReceiptDraft {
  localReceiptId: string;
  pages: ReceiptSection[];
}

interface ScannerSessionBase {
  selectedReceiptId: string | null;
  selectedPageId: string | null;
  /** Batch receipt waiting for an explicit Keep receipt action. */
  pendingReceiptId: string | null;
  stage: ScannerSessionStage;
}

export interface StandardScannerSession extends ScannerSessionBase {
  mode: 'standard';
  receipts: [] | [CapturedReceiptDraft];
}

export interface BatchScannerSession extends ScannerSessionBase {
  mode: 'batch';
  receipts: CapturedReceiptDraft[];
}

export type ScannerSession = StandardScannerSession | BatchScannerSession;

function imageIdentities(section: ReceiptSection): string[] {
  return section.sourceAssetUri
    ? [section.sourceAssetUri, section.originalUri]
    : [section.originalUri];
}

function normalizedRestoredPageIds(
  sections: readonly ReceiptSection[],
): ReceiptSection[] {
  const reservedIds = new Set(sections.map((section) => section.localId));
  const usedIds = new Set<string>();
  return sections.map((section) => {
    if (!usedIds.has(section.localId)) {
      usedIds.add(section.localId);
      return section;
    }
    let suffix = 2;
    let localId = `${section.localId}-${suffix}`;
    while (usedIds.has(localId) || reservedIds.has(localId)) {
      suffix += 1;
      localId = `${section.localId}-${suffix}`;
    }
    usedIds.add(localId);
    return { ...section, localId };
  });
}

function buildSession(
  mode: ScannerSessionMode,
  receipts: CapturedReceiptDraft[],
  selectedReceiptId: string | null,
  selectedPageId: string | null,
  stage: ScannerSessionStage,
  pendingReceiptId: string | null = null,
): ScannerSession {
  if (mode === 'standard') {
    if (receipts.length > 1) {
      throw new Error('Standard mode can contain only one receipt.');
    }
    return {
      mode,
      receipts: receipts.length === 0 ? [] : [receipts[0]!],
      selectedReceiptId,
      selectedPageId,
      pendingReceiptId: null,
      stage,
    };
  }
  const validPendingReceiptId = pendingReceiptId
    && receipts.some((receipt) => receipt.localReceiptId === pendingReceiptId)
    ? pendingReceiptId
    : null;
  return {
    mode,
    receipts,
    selectedReceiptId,
    selectedPageId,
    pendingReceiptId: validPendingReceiptId,
    stage,
  };
}

function findPage(
  receipts: readonly CapturedReceiptDraft[],
  pageId: string | null,
): { receiptIndex: number; pageIndex: number } | null {
  if (!pageId) return null;
  for (let receiptIndex = 0; receiptIndex < receipts.length; receiptIndex += 1) {
    const pageIndex = receipts[receiptIndex]!.pages.findIndex((page) => page.localId === pageId);
    if (pageIndex >= 0) return { receiptIndex, pageIndex };
  }
  return null;
}

function uniqueIncomingSections(
  session: ScannerSession,
  incoming: readonly ReceiptSection[],
): ReceiptSection[] {
  if (incoming.length === 0) return [];
  const normalizedIncoming = addSessionSections([], [...incoming]);
  const existingImages = new Set<string>();
  const existingPageIds = new Set<string>();
  for (const receipt of session.receipts) {
    for (const page of receipt.pages) {
      imageIdentities(page).forEach((identity) => existingImages.add(identity));
      existingPageIds.add(page.localId);
    }
  }
  const incomingImages = new Set<string>();
  const incomingPageIds = new Set<string>();
  return normalizedIncoming.filter((page) => {
    const images = imageIdentities(page);
    if (
      images.some((identity) => existingImages.has(identity) || incomingImages.has(identity))
      || existingPageIds.has(page.localId)
      || incomingPageIds.has(page.localId)
    ) return false;
    images.forEach((identity) => incomingImages.add(identity));
    incomingPageIds.add(page.localId);
    return true;
  });
}

function explicitDraft(localReceiptId: string, pages: readonly ReceiptSection[]): CapturedReceiptDraft {
  return {
    localReceiptId,
    pages: pages.map((page) => ({ ...page, receiptGroupId: localReceiptId })),
  };
}

export function normalizeInitialSections(
  initialSections: readonly ReceiptSection[],
): CapturedReceiptDraft[] {
  if (initialSections.length === 0) return [];
  const canonicalSections = normalizedRestoredPageIds(initialSections).map((section) => {
    const receiptGroupId = section.receiptGroupId?.trim();
    return receiptGroupId === section.receiptGroupId
      ? section
      : { ...section, receiptGroupId: receiptGroupId || undefined };
  });
  const explicitSections = makeReceiptGroupsExplicit(canonicalSections);
  const groups = groupReceiptMembers(explicitSections);
  if (groups.length > MAX_RECEIPTS_PER_CAPTURE_BATCH) {
    throw new Error(`A batch can contain up to ${MAX_RECEIPTS_PER_CAPTURE_BATCH} receipts.`);
  }
  return groups.map((pages) => {
    if (pages.length > MAX_SECTIONS) {
      throw new Error(`A receipt can contain up to ${MAX_SECTIONS} sections.`);
    }
    const localReceiptId = pages[0]!.receiptGroupId!;
    return explicitDraft(localReceiptId, pages);
  });
}

export function createScannerSession(
  initialSections: readonly ReceiptSection[] = [],
  requestedMode?: ScannerSessionMode,
): ScannerSession {
  const receipts = normalizeInitialSections(initialSections);
  const mode = receipts.length > 1 ? 'batch' : requestedMode ?? 'standard';
  const firstReceipt = receipts[0] ?? null;
  return buildSession(
    mode,
    receipts,
    firstReceipt?.localReceiptId ?? null,
    firstReceipt?.pages[0]?.localId ?? null,
    firstReceipt ? 'review' : 'capture',
  );
}

export function restoreScannerSession(
  initialSections: readonly ReceiptSection[],
  requestedMode?: ScannerSessionMode,
): ScannerSession {
  return createScannerSession(initialSections, requestedMode);
}

export function captureReceipt(
  session: ScannerSession,
  sections: readonly ReceiptSection[],
  receiptGroupId?: string,
): ScannerSession {
  const uniqueSections = uniqueIncomingSections(session, sections);
  if (uniqueSections.length === 0) return session;
  if (session.mode === 'standard' && session.receipts.length > 0) {
    throw new Error('Review or replace the current receipt before capturing another.');
  }
  if (session.mode === 'batch' && session.pendingReceiptId) {
    throw new Error('Keep or discard the current receipt before capturing another.');
  }
  if (session.mode === 'batch' && session.receipts.length >= MAX_RECEIPTS_PER_CAPTURE_BATCH) {
    throw new Error(`A batch can contain up to ${MAX_RECEIPTS_PER_CAPTURE_BATCH} receipts.`);
  }

  const localReceiptId = (receiptGroupId ?? newReceiptGroupId()).trim();
  if (!localReceiptId) throw new Error('Receipt group ID cannot be empty.');
  if (session.receipts.some((receipt) => receipt.localReceiptId === localReceiptId)) {
    throw new Error('This receipt is already in the batch.');
  }

  const draft = explicitDraft(localReceiptId, uniqueSections);
  const receipts = [...session.receipts, draft];
  return buildSession(
    session.mode,
    receipts,
    draft.localReceiptId,
    draft.pages[0]!.localId,
    'review',
    session.mode === 'batch' ? draft.localReceiptId : null,
  );
}

/** Accepts the pending Batch receipt and returns to live capture. */
export function acceptPendingReceipt(session: ScannerSession): ScannerSession {
  if (session.mode !== 'batch' || !session.pendingReceiptId) return session;
  return buildSession('batch', session.receipts, null, null, 'capture', null);
}

/** Discards only the pending Batch receipt. Previously accepted receipts stay intact. */
export function discardPendingReceipt(session: ScannerSession): ScannerSession {
  if (session.mode !== 'batch' || !session.pendingReceiptId) return session;
  const receipts = session.receipts.filter(
    (receipt) => receipt.localReceiptId !== session.pendingReceiptId,
  );
  return buildSession('batch', receipts, null, null, 'capture', null);
}

export function addReceiptPage(
  session: ScannerSession,
  receiptId: string,
  sections: readonly ReceiptSection[],
): ScannerSession {
  const receiptIndex = session.receipts.findIndex((receipt) => receipt.localReceiptId === receiptId);
  if (receiptIndex < 0) return session;

  const uniqueSections = uniqueIncomingSections(session, sections);
  if (uniqueSections.length === 0) return session;
  const receipt = session.receipts[receiptIndex]!;
  if (receipt.pages.length + uniqueSections.length > MAX_SECTIONS) {
    throw new Error(`A receipt can contain up to ${MAX_SECTIONS} sections.`);
  }

  const pages = addSessionSections(receipt.pages, uniqueSections)
    .map((page) => ({ ...page, receiptGroupId: receipt.localReceiptId }));
  const receipts = session.receipts.map((candidate, index) => (
    index === receiptIndex ? { ...candidate, pages } : candidate
  ));
  const selectedPage = pages[receipt.pages.length]!;
  return buildSession(
    session.mode,
    receipts,
    receipt.localReceiptId,
    selectedPage.localId,
    'review',
    session.pendingReceiptId,
  );
}

export function replaceReceiptPage(
  session: ScannerSession,
  pageId: string,
  replacement: ReceiptSection,
): ScannerSession {
  const location = findPage(session.receipts, pageId);
  if (!location) {
    throw new Error('Select one photo to replace this section.');
  }

  const flattened = session.receipts.flatMap((receipt) => receipt.pages);
  const replacementImages = new Set(imageIdentities(replacement));
  if (flattened.some((page) => (
    page.localId !== pageId
    && imageIdentities(page).some((identity) => replacementImages.has(identity))
  ))) {
    throw new Error('This photo is already in your receipt.');
  }
  const replaced = addSessionSections(flattened, [replacement], pageId)
    .find((page) => page.localId === pageId)!;
  const receipt = session.receipts[location.receiptIndex]!;
  const pages = receipt.pages.map((page) => (
    page.localId === pageId
      ? { ...replaced, receiptGroupId: receipt.localReceiptId }
      : page
  ));
  const receipts = session.receipts.map((candidate, index) => (
    index === location.receiptIndex ? { ...candidate, pages } : candidate
  ));
  return buildSession(
    session.mode,
    receipts,
    receipt.localReceiptId,
    pageId,
    'review',
    session.pendingReceiptId,
  );
}

export function removeReceiptPage(
  session: ScannerSession,
  pageId: string,
): ScannerSession {
  const location = findPage(session.receipts, pageId);
  if (!location) return session;

  const receipt = session.receipts[location.receiptIndex]!;
  const remainingPages = receipt.pages.filter((page) => page.localId !== pageId);
  const receipts = remainingPages.length > 0
    ? session.receipts.map((candidate, index) => (
      index === location.receiptIndex ? { ...candidate, pages: remainingPages } : candidate
    ))
    : session.receipts.filter((_, index) => index !== location.receiptIndex);

  const selectedPageStillExists = findPage(receipts, session.selectedPageId) !== null;
  const selectedReceiptStillExists = session.selectedReceiptId !== null
    && receipts.some((candidate) => candidate.localReceiptId === session.selectedReceiptId);
  if (selectedPageStillExists || (session.selectedPageId === null && selectedReceiptStillExists)) {
    return buildSession(
      session.mode,
      receipts,
      session.selectedReceiptId,
      session.selectedPageId,
      session.stage,
      session.pendingReceiptId,
    );
  }

  const fallbackReceipt = remainingPages.length > 0
    ? receipts[location.receiptIndex]!
    : receipts[Math.min(location.receiptIndex, receipts.length - 1)] ?? null;
  const fallbackPage = remainingPages.length > 0
    ? fallbackReceipt?.pages[Math.min(location.pageIndex, fallbackReceipt.pages.length - 1)] ?? null
    : fallbackReceipt?.pages[0] ?? null;
  const stage = fallbackReceipt
    ? session.stage === 'capture' ? 'capture' : 'review'
    : 'capture';
  return buildSession(
    session.mode,
    receipts,
    fallbackReceipt?.localReceiptId ?? null,
    fallbackPage?.localId ?? null,
    stage,
    receipts.some((candidate) => candidate.localReceiptId === session.pendingReceiptId)
      ? session.pendingReceiptId
      : null,
  );
}

export function removeCapturedReceipt(
  session: ScannerSession,
  receiptId: string,
): ScannerSession {
  const receiptIndex = session.receipts.findIndex((receipt) => receipt.localReceiptId === receiptId);
  if (receiptIndex < 0) return session;
  const receipts = session.receipts.filter((_, index) => index !== receiptIndex);
  if (session.selectedReceiptId !== receiptId) {
    return buildSession(
      session.mode,
      receipts,
      session.selectedReceiptId,
      session.selectedPageId,
      session.stage,
      session.pendingReceiptId,
    );
  }
  const fallbackReceipt = receipts[Math.min(receiptIndex, receipts.length - 1)] ?? null;
  return buildSession(
    session.mode,
    receipts,
    fallbackReceipt?.localReceiptId ?? null,
    fallbackReceipt?.pages[0]?.localId ?? null,
    fallbackReceipt && session.stage === 'capture' ? 'capture' : fallbackReceipt ? 'review' : 'capture',
    session.pendingReceiptId === receiptId ? null : session.pendingReceiptId,
  );
}

export function reorderReceipt(
  session: ScannerSession,
  receiptId: string,
  delta: number,
): ScannerSession {
  if (session.mode === 'standard') return session;
  const index = session.receipts.findIndex((receipt) => receipt.localReceiptId === receiptId);
  const receipts = moveSection(session.receipts, index, delta);
  return receipts === session.receipts ? session : { ...session, receipts };
}

export function reorderReceiptPage(
  session: ScannerSession,
  pageId: string,
  delta: number,
): ScannerSession {
  const location = findPage(session.receipts, pageId);
  if (!location) return session;
  const receipt = session.receipts[location.receiptIndex]!;
  const pages = moveSessionSection(receipt.pages, pageId, delta);
  if (pages === receipt.pages) return session;
  const receipts = session.receipts.map((candidate, index) => (
    index === location.receiptIndex ? { ...candidate, pages } : candidate
  ));
  return buildSession(
    session.mode,
    receipts,
    session.selectedReceiptId,
    session.selectedPageId,
    session.stage,
    session.pendingReceiptId,
  );
}

export function selectReceipt(
  session: ScannerSession,
  receiptId: string | null,
): ScannerSession {
  if (receiptId === null) {
    if (session.selectedReceiptId === null && session.selectedPageId === null) return session;
    const stage = session.stage === 'crop' || session.stage === 'filter' || session.stage === 'retake'
      ? session.receipts.length > 0 ? 'review' : 'capture'
      : session.stage;
    return { ...session, selectedReceiptId: null, selectedPageId: null, stage };
  }
  const receipt = session.receipts.find((candidate) => candidate.localReceiptId === receiptId);
  if (!receipt) return session;
  const selectedPageBelongsToReceipt = receipt.pages.some((page) => page.localId === session.selectedPageId);
  const selectedPageId = selectedPageBelongsToReceipt
    ? session.selectedPageId
    : receipt.pages[0]?.localId ?? null;
  const changedReceipt = session.selectedReceiptId !== receiptId;
  const stage = changedReceipt && (
    session.stage === 'crop' || session.stage === 'filter' || session.stage === 'retake'
  ) ? 'review' : session.stage;
  if (!changedReceipt && selectedPageId === session.selectedPageId && stage === session.stage) return session;
  return { ...session, selectedReceiptId: receiptId, selectedPageId, stage };
}

export function selectPage(
  session: ScannerSession,
  pageId: string | null,
): ScannerSession {
  if (pageId === null) {
    if (session.selectedPageId === null) return session;
    const stage = session.stage === 'crop' || session.stage === 'filter' || session.stage === 'retake'
      ? 'review'
      : session.stage;
    return { ...session, selectedPageId: null, stage };
  }
  const location = findPage(session.receipts, pageId);
  if (!location) return session;
  const receiptId = session.receipts[location.receiptIndex]!.localReceiptId;
  if (session.selectedReceiptId === receiptId && session.selectedPageId === pageId) return session;
  const stage = session.stage === 'crop' || session.stage === 'filter' || session.stage === 'retake'
    ? 'review'
    : session.stage;
  return { ...session, selectedReceiptId: receiptId, selectedPageId: pageId, stage };
}

export function setScannerStage(
  session: ScannerSession,
  stage: ScannerSessionStage,
): ScannerSession {
  if (stage === session.stage) return session;
  if (stage === 'review' && session.receipts.length === 0) {
    return session.stage === 'capture' ? session : { ...session, stage: 'capture' };
  }
  if (
    (stage === 'crop' || stage === 'filter' || stage === 'retake')
    && !findPage(session.receipts, session.selectedPageId)
  ) {
    return session;
  }
  return { ...session, stage };
}

export function switchScannerMode(
  session: ScannerSession,
  mode: ScannerSessionMode,
): ScannerSession {
  if (session.mode === mode || session.receipts.length > 0) return session;
  return buildSession(mode, [], null, null, 'capture');
}

export function resetScannerSession(
  session: ScannerSession,
  mode: ScannerSessionMode = session.mode,
): ScannerSession {
  return buildSession(mode, [], null, null, 'capture');
}

export function flattenScannerSession(session: ScannerSession): ReceiptSection[] {
  return session.receipts.flatMap((receipt) => (
    receipt.pages.map((page) => ({ ...page, receiptGroupId: receipt.localReceiptId }))
  ));
}

export function confirmScannerSession(session: ScannerSession): ReceiptSection[] {
  if (session.mode === 'batch' && session.pendingReceiptId) {
    throw new Error('Keep or discard the current receipt before finishing the batch.');
  }
  return flattenScannerSession(session);
}
