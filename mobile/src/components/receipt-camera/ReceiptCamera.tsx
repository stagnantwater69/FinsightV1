/** Standard captures one receipt; Batch captures one long receipt as ordered
 * parts that share a receipt group, so they upload and are read as one receipt.
 * Legacy long/manual metadata remains readable but is not offered for new sessions. */
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState, type ForwardedRef } from 'react';
import { ActivityIndicator, Alert, AppState, BackHandler, Image, Linking, Platform, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as ImagePicker from 'expo-image-picker';
import * as Manipulator from 'expo-image-manipulator';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../context/ThemeContext';
import { font, typeScale } from '../../theme/tokens';
import { TAP_FLOOR } from '../touchTarget';
import { ApiError, api } from '../../lib/api';
import { transformFailureMessage } from '../../lib/cropQuad';
import * as haptics from '../../lib/haptics';
import { CAPTURE_QUALITY, MAX_SECTIONS, cornersFromFractions, type Corners, type ReceiptSection, type SectionQuality } from '../../lib/receiptCapture';
import { createReceiptSection, moveSessionSection, qualityHint } from '../../lib/receiptCameraSession';
import { analysisImageUri } from '../../lib/analysisImage';
import { USE_NATIVE_RECEIPT_CAMERA } from '../../lib/receiptScannerFeature';
import { applyReceiptFilter, type ReceiptFilterMode } from '../../lib/receiptFilters';
import { groupReceiptMembers, MAX_RECEIPTS_PER_CAPTURE_BATCH, newReceiptGroupId } from '../../lib/receiptGrouping';
import { NativeReceiptCamera } from './NativeReceiptCamera';
import { CameraAction } from './CameraAction';
import { CropEditor } from './CropEditor';
import { ReceiptFilterSheet } from './ReceiptFilterSheet';
import { ScannerModeSelector } from './ScannerModeSelector';
import { CaptureStatusPill, ShutterRow } from './CaptureChrome';
import { PageReviewer } from './PageReviewer';
import { ReviewToolbar } from './ReviewToolbar';
import { clampPageIndex, reviewConfirmAction, showAddPageSlot } from '../../lib/reviewPager';
import { addReceiptPage, captureReceipt, createScannerSession, flattenScannerSession, replaceReceiptPage, type ScannerSession, type ScannerSessionMode } from './scannerSession';
import { getCustomScannerView, isCustomScannerOutdated, parseScannerStatus, receiptSectionFromNative, type ScannerCommand } from '../../lib/customReceiptScanner';
import { deleteReceiptScannerFiles } from '../../lib/receiptScannerCache';

export interface ReceiptCameraProps {
  initialSections?: ReceiptSection[];
  maxReceipts?: number;
  onCancel: () => void;
  onDone: (sections: ReceiptSection[]) => void;
}
export interface ReceiptCameraHandle { requestClose: () => void; }
type FilterBase = Pick<ReceiptSection, 'processedUri' | 'processedMimeType' | 'processingMode' | 'transformVersion' | 'width' | 'height'>;

interface StagedBatchReceipt {
  pageId: string;
  previousSections: ReceiptSection[];
  previousFilterBase?: FilterBase;
  previousFilterSelection?: ReceiptFilterMode;
}

function filterSourceUri(section: ReceiptSection): string | undefined {
  return section.filterSourceUri;
}

function initialFilterMode(section: ReceiptSection): ReceiptFilterMode {
  if (section.processingMode === 'clear-colour') return 'enhanced';
  if (section.processingMode === 'grayscale') return 'grayscale';
  if (section.processingMode === 'black-white') return 'black-white';
  return 'original';
}

export const ReceiptCamera = forwardRef<ReceiptCameraHandle, ReceiptCameraProps>(function ReceiptCamera(props, ref) {
  return USE_NATIVE_RECEIPT_CAMERA
    ? <NativeReceiptCamera initialSections={props.initialSections} maxReceipts={props.maxReceipts} onCancel={props.onCancel} onDone={props.onDone} />
    : <CustomReceiptCamera {...props} handleRef={ref} />;
});

function CustomReceiptCamera({ initialSections = [], maxReceipts = MAX_RECEIPTS_PER_CAPTURE_BATCH, onCancel, onDone, handleRef }: ReceiptCameraProps & { handleRef: ForwardedRef<ReceiptCameraHandle> }) {
  const t = useTheme(); const insets = useSafeAreaInsets();
  const { fontScale } = useWindowDimensions();
  const batchReceiptLimit = Number.isFinite(maxReceipts)
    ? Math.min(MAX_RECEIPTS_PER_CAPTURE_BATCH, Math.max(1, Math.floor(maxReceipts)))
    : MAX_RECEIPTS_PER_CAPTURE_BATCH;
  const NativeScanner = getCustomScannerView();
  const nativeScannerAvailable = NativeScanner !== null;
  const [command, setCommand] = useState<ScannerCommand>({ id: 0, type: 'reset' });
  const [scanning, setScanning] = useState(false);
  const [capturePending, setCapturePending] = useState(false);
  const [zoomRatio, setZoomRatio] = useState<1 | 2>(1);
  const [maxZoomRatio, setMaxZoomRatio] = useState<number | null>(null);
  const [nativeProcessing, setNativeProcessing] = useState(false);
  const [scannerMessage, setScannerMessage] = useState('Position the receipt on a contrasting surface.');
  const nativeAccepted = useRef(false);
  const nativeVisible = useRef(false);
  const nativeEpoch = useRef(0);
  const longStarted = useRef(false);
  const autoLongRequested = useRef(false);
  const [scannerFileLifecycle] = useState(() => ({ created: new Set<string>(), handedOff: false }));
  const eventEpoch = nativeEpoch.current;
  const [permission, requestPermission, getPermission] = useCameraPermissions();
  // A restored receipt with several parts is a long receipt: reopen it in
  // Batch so another part can be added below the last one.
  const [restoredInitialSession] = useState<ScannerSession>(() => createScannerSession(
    initialSections,
    initialSections.length > 1 && groupReceiptMembers([...initialSections]).length === 1 ? 'batch' : undefined,
  ));
  const [sections, setSections] = useState<ReceiptSection[]>(() => flattenScannerSession(restoredInitialSession));
  const [mode, setMode] = useState<'standard' | 'long'>('standard');
  const [sessionMode, setSessionMode] = useState<ScannerSessionMode>(restoredInitialSession.mode);
  const [manualSections, setManualSections] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(() => {
    if (restoredInitialSession.mode !== 'batch' || (restoredInitialSession.receipts.at(-1)?.pages.length ?? 0) < MAX_SECTIONS) return null;
    return restoredInitialSession.receipts.at(-1)?.pages.at(-1)?.localId ?? null;
  });
  const [replaceId, setReplaceId] = useState<string | null>(null);
  const [cropping, setCropping] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  /** Review is resting on the Add Page card rather than on a page. */
  const [onAddSlot, setOnAddSlot] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [sessionStartedAt] = useState(() => new Date());
  const [ready, setReady] = useState(false);
  const [active, setActive] = useState(AppState.currentState === 'active');
  const [textLayoutRevision, setTextLayoutRevision] = useState(0);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [torch, setTorch] = useState(false);
  const [busy, setBusy] = useState(false);
  /**
   * The handoff to the parent is in flight (or has happened and the parent has
   * not unmounted this screen yet). Keeps a second tap from submitting the same
   * sections twice WITHOUT wedging `locked`, which gates every other action.
   */
  const [submitting, setSubmitting] = useState(false);
  const handoffLatched = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [cameraError, setCameraError] = useState(false);
  const camera = useRef<CameraView>(null);
  const mounted = useRef(true); const locked = useRef(false); const version = useRef(0); const dirty = useRef(false);
  const captureActivity = useRef({ mode, manualSections, scanning, nativeProcessing });
  captureActivity.current = { mode, manualSections, scanning, nativeProcessing };
  const interruptedLongScan = useRef(false);
  const operationAbort = useRef<AbortController | null>(null);
  /**
   * The native epoch a shutter press was sent in. While it still matches, a
   * still is in flight, so a late preview status ("edges not clear") must not
   * re-enable the shutter. Any epoch change ends the wait; the watchdog is a
   * backstop for a result that never arrives.
   */
  const captureRequestEpoch = useRef<number | null>(null);
  const captureWatchdog = useRef<ReturnType<typeof setTimeout> | null>(null);
  const filterSources = useRef(new Map<string, FilterBase>());
  const filterSelections = useRef(new Map<string, ReceiptFilterMode>());
  const [stagedBatch, setStagedBatch] = useState<StagedBatchReceipt | null>(null);
  const stagedConfirmLatched = useRef(false);
  const pendingFileReleases = useRef(new Set<string>());
  const closeRef = useRef<() => void>(() => {});
  useImperativeHandle(handleRef, () => ({ requestClose: () => closeRef.current() }), []);
  const selected = sections.find(s => s.localId === selectedId);
  const continuous = nativeScannerAvailable && !manualSections;
  const nativeManual = nativeScannerAvailable && manualSections;
  const nativeViewActive = continuous || nativeManual;
  /** Filters run in the Android scanner module; other builds show the photo as captured. */
  const localFilters = Platform.OS === 'android' && nativeScannerAvailable;
  const nativeInteractionMode = sessionMode === 'batch' ? 'standard' : nativeManual ? 'manual' : mode;
  const nativeAutoCapture = sessionMode === 'standard' && !nativeManual && mode === 'standard';
  const receiptGroups = groupReceiptMembers(sections);
  const selectedGroupIndex = selected ? receiptGroups.findIndex(group => group.some(section => section.localId === selected.localId)) : -1;
  const selectedGroup = selectedGroupIndex >= 0 ? receiptGroups[selectedGroupIndex] : undefined;
  const selectedPageIndex = selected && selectedGroup
    ? selectedGroup.findIndex(section => section.localId === selected.localId)
    : -1;
  const stagedSelected = Boolean(stagedBatch && selected?.localId === stagedBatch.pageId);
  const stagedGroupIndex = stagedBatch
    ? receiptGroups.findIndex(group => group.some(section => section.localId === stagedBatch.pageId))
    : -1;
  const readyReceiptCount = Math.max(0, receiptGroups.length - (stagedGroupIndex >= 0 ? 1 : 0));
  /** Parts of the long receipt being built; Batch adds each capture to it. */
  const batchParts = receiptGroups.at(-1) ?? [];
  const keptPartCount = Math.max(0, batchParts.length - (stagedBatch ? 1 : 0));
  const full = (sessionMode === 'batch' ? batchParts.length >= MAX_SECTIONS : sections.length >= 1) && !replaceId;

  useEffect(() => {
    mounted.current = true;
    const sub = AppState.addEventListener('change', state => {
      const foreground = state === 'active'; setActive(foreground);
      if (!foreground) {
        const capture = captureActivity.current;
        interruptedLongScan.current = capture.mode === 'long' && !capture.manualSections && (capture.scanning || capture.nativeProcessing);
        nativeEpoch.current++; longStarted.current = false; autoLongRequested.current = false; nativeVisible.current = false; setTorch(false); setReady(false); setScanning(false); setCapturePending(false); setNativeProcessing(false); setCommand(c => ({ id: c.id + 1, type: 'reset' })); setScannerMessage('Camera paused. Position the receipt and try again.');
      }
      else {
        // Android can update native font scaling before Dimensions reflects
        // it. Recreate only text/control hosts on return from Settings.
        setTextLayoutRevision((revision) => revision + 1);
        void getPermission().catch(() => undefined);
        if (interruptedLongScan.current) {
          interruptedLongScan.current = false;
          Alert.alert(
            'Long scan was interrupted',
            'Android stopped the unfinished section session while FinSight was in the background. The unfinished mosaic was not saved; previously reviewed images are kept.',
            [
              {
                text: 'Use manual pages',
                onPress: () => {
                  setMode('long');
                  setManualSections(true);
                  setScannerMessage('Photograph each part in printed order with a few lines of overlap.');
                },
              },
              {
                text: 'Restart long scan',
                onPress: () => {
                  setMode('long');
                  setManualSections(false);
                  autoLongRequested.current = false;
                  setScannerMessage('Position the top of the receipt, then tap the shutter.');
                },
              },
            ],
          );
        }
      }
    });
    const back = BackHandler.addEventListener('hardwareBackPress', () => { closeRef.current(); return true; });
    // Invalidate late async camera work before releasing listeners and files.
    return () => {
      mounted.current = false;
      // Cleanup must invalidate the latest operation, not the value at effect setup.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      version.current++;
      operationAbort.current?.abort();
      if (captureWatchdog.current) clearTimeout(captureWatchdog.current);
      sub.remove();
      back.remove();
      if (!scannerFileLifecycle.handedOff) {
        void deleteReceiptScannerFiles([...scannerFileLifecycle.created]);
      }
    };
  }, [getPermission, scannerFileLifecycle]);

  function close() {
    if (handoffLatched.current) return;
    if (scanning || nativeProcessing) {
      Alert.alert('Discard the current scan?', 'Your unfinished receipt will be lost. Previously reviewed receipts are kept.', [
        { text: 'Keep scanning', style: 'cancel' }, { text: 'Discard scan', style: 'destructive', onPress: () => { nativeEpoch.current++; longStarted.current = false; autoLongRequested.current = false; setCommand(c => ({ id: c.id + 1, type: 'reset' })); setScanning(false); setCapturePending(false); setNativeProcessing(false); } },
      ]); return;
    }
    if (locked.current) {
      version.current++; operationAbort.current?.abort(); locked.current = false;
      setBusy(false); setPickerOpen(false); setError(null);
    }
    if (moreOpen) { setMoreOpen(false); return; }
    if (filtersOpen) { setFiltersOpen(false); return; }
    if (cropping) { setCropping(false); return; }
    if (stagedSelected) {
      Alert.alert(
        'Discard this unconfirmed part?',
        'This photo has not been added to the receipt. Keep editing or discard it and return to the camera.',
        [
          { text: 'Keep editing', style: 'cancel' },
          { text: 'Discard photo', style: 'destructive', onPress: discardStagedCapture },
        ],
      );
      return;
    }
    if (selected) { nativeEpoch.current++; setSelectedId(null); setOnAddSlot(false); return; }
    if (replaceId) {
      nativeEpoch.current++; longStarted.current = false; autoLongRequested.current = false;
      setReplaceId(null);
      setSelectedId(stagedBatch?.pageId ?? replaceId);
      return;
    }
    if (dirty.current) Alert.alert('Discard this capture session?', 'Your captured receipts have not been sent for scanning.', [
      { text: 'Keep editing', style: 'cancel' }, { text: 'Discard', style: 'destructive', onPress: () => { void deleteReceiptScannerFiles([...scannerFileLifecycle.created]); onCancel(); } },
    ]); else onCancel();
  }
  closeRef.current = close;

  async function run(action: (isCurrent: () => boolean, signal: AbortSignal) => Promise<void>) {
    if (locked.current) return;
    const token = ++version.current;
    const controller = new AbortController(); operationAbort.current = controller;
    const isCurrent = () => mounted.current && version.current === token;
    locked.current = true; setBusy(true); setError(null);
    try { await action(isCurrent, controller.signal); }
    catch (e) { if (isCurrent()) { setError(e instanceof Error ? e.message : 'Could not finish this action. Please try again.'); haptics.failed(); } }
    finally { if (isCurrent()) { locked.current = false; setBusy(false); operationAbort.current = null; } }
  }
  function put(next: ReceiptSection[]) { dirty.current = true; setSections(next); }
  function updateSection(next: ReceiptSection) { put(sections.map(s => s.localId === next.localId ? next : s)); }
  const protectedCacheUris = useCallback((currentSections: readonly ReceiptSection[]): Set<string> => {
    const currentIds = new Set(currentSections.map(section => section.localId));
    const uris = new Set<string>();
    for (const section of currentSections) {
      uris.add(section.originalUri);
      uris.add(section.processedUri);
      const immutableFilterUri = filterSourceUri(section);
      if (immutableFilterUri) uris.add(immutableFilterUri);
    }
    for (const [localId, base] of filterSources.current) {
      if (currentIds.has(localId)) uris.add(base.processedUri);
    }
    if (stagedBatch) {
      for (const section of stagedBatch.previousSections) {
        uris.add(section.originalUri);
        uris.add(section.processedUri);
        if (section.filterSourceUri) uris.add(section.filterSourceUri);
      }
      if (stagedBatch.previousFilterBase) {
        uris.add(stagedBatch.previousFilterBase.processedUri);
      }
    }
    return uris;
  }, [stagedBatch]);
  function releaseCreatedUris(candidates: readonly (string | undefined)[]) {
    for (const uri of candidates) {
      if (uri && scannerFileLifecycle.created.has(uri)) pendingFileReleases.current.add(uri);
    }
  }
  function sectionUris(section: ReceiptSection): (string | undefined)[] {
    return [section.originalUri, section.processedUri, section.filterSourceUri];
  }
  function stageBatchCapture(next: ReceiptSection[], pageId: string, replacing?: string | null) {
    const continuing = replacing && stagedBatch?.pageId === replacing ? stagedBatch : null;
    const currentSection = replacing ? sections.find(section => section.localId === replacing) : undefined;
    const currentFilterBase = replacing ? filterSources.current.get(replacing) : undefined;
    const previousSections = continuing?.previousSections ?? sections;
    const previousFilterBase = continuing?.previousFilterBase ?? currentFilterBase;
    const previousFilterSelection = continuing?.previousFilterSelection
      ?? (replacing ? filterSelections.current.get(replacing) : undefined);

    if (continuing && currentSection) {
      releaseCreatedUris([...sectionUris(currentSection), currentFilterBase?.processedUri]);
    }
    if (replacing) {
      filterSources.current.delete(replacing);
      filterSelections.current.delete(replacing);
    }

    stagedConfirmLatched.current = false;
    setStagedBatch({ pageId, previousSections, previousFilterBase, previousFilterSelection });
    put(next);
    setSelectedId(pageId);
    setReplaceId(null);
    setReady(false);
    setFiltersOpen(false);
    setScannerMessage('Review this capture before adding it to the batch.');
  }
  function confirmStagedCapture() {
    if (!stagedBatch || stagedConfirmLatched.current || locked.current) return;
    stagedConfirmLatched.current = true;
    const priorUris = stagedBatch.previousSections.flatMap(sectionUris);
    releaseCreatedUris([...priorUris, stagedBatch.previousFilterBase?.processedUri]);
    const partNumber = Math.max(1, (receiptGroups[stagedGroupIndex] ?? []).findIndex(section => section.localId === stagedBatch.pageId) + 1);
    const isFull = batchParts.length >= MAX_SECTIONS;
    setStagedBatch(null);
    setSections(current => [...current]);
    setSelectedId(null);
    setReplaceId(null);
    setCropping(false);
    setFiltersOpen(false);
    setReady(false);
    nativeAccepted.current = false;
    setCommand(current => ({ id: current.id + 1, type: 'reset' }));
    setScannerMessage(isFull
      ? `Part ${partNumber} kept. This receipt has ${MAX_SECTIONS} parts, the most one scan can hold. Open it to finish.`
      : `Part ${partNumber} kept. Move down to the next part and keep a few lines of the last part in view.`);
    haptics.committed();
  }
  function discardStagedCapture() {
    if (!stagedBatch) return;
    const currentSection = sections.find(section => section.localId === stagedBatch.pageId);
    const currentFilterBase = filterSources.current.get(stagedBatch.pageId);
    if (currentSection) {
      releaseCreatedUris([...sectionUris(currentSection), currentFilterBase?.processedUri]);
    }
    filterSources.current.delete(stagedBatch.pageId);
    filterSelections.current.delete(stagedBatch.pageId);
    if (stagedBatch.previousFilterBase) {
      filterSources.current.set(stagedBatch.pageId, stagedBatch.previousFilterBase);
    }
    if (stagedBatch.previousFilterSelection) {
      filterSelections.current.set(stagedBatch.pageId, stagedBatch.previousFilterSelection);
    }
    const restored = stagedBatch.previousSections;
    setSections(restored);
    dirty.current = restored.length > 0;
    stagedConfirmLatched.current = false;
    setStagedBatch(null);
    setSelectedId(null);
    setReplaceId(null);
    setCropping(false);
    setFiltersOpen(false);
    setReady(false);
    nativeAccepted.current = false;
    nativeEpoch.current++;
    setCommand(current => ({ id: current.id + 1, type: 'reset' }));
    const keptCount = groupReceiptMembers(restored).at(-1)?.length ?? 0;
    setScannerMessage(keptCount > 0
      ? `${keptCount} ${keptCount === 1 ? 'part' : 'parts'} kept. Capture the next part of the receipt.`
      : 'Start at the top of the receipt. The whole receipt does not need to fit.');
    haptics.tapped();
  }
  useEffect(() => {
    const protectedUris = protectedCacheUris(sections);
    const disposable = [...pendingFileReleases.current].filter(uri => !protectedUris.has(uri));
    if (!disposable.length) return;
    disposable.forEach(uri => {
      pendingFileReleases.current.delete(uri);
      scannerFileLifecycle.created.delete(uri);
    });
    void deleteReceiptScannerFiles(disposable);
  }, [protectedCacheUris, scannerFileLifecycle, sections]);
  function assertWithinBatchCapacity(next: readonly ReceiptSection[]) {
    if (sessionMode !== 'batch') return;
    const groups = groupReceiptMembers([...next]);
    if (groups.length > batchReceiptLimit) {
      throw new Error(`This capture can hold up to ${batchReceiptLimit} ${batchReceiptLimit === 1 ? 'receipt' : 'receipts'}.`);
    }
    if ((groups.at(-1)?.length ?? 0) > MAX_SECTIONS) {
      throw new Error(`A long receipt can have up to ${MAX_SECTIONS} parts.`);
    }
  }
  function mergeCapturedSections(current: ReceiptSection[], incoming: ReceiptSection[], replacing?: string | null): ReceiptSection[] {
    let session: ScannerSession = createScannerSession(current, sessionMode);
    if (replacing) {
      if (incoming.length !== 1) throw new Error('Select one photo to replace this receipt.');
      const next = flattenScannerSession(replaceReceiptPage(session, replacing, incoming[0]!));
      assertWithinBatchCapacity(next);
      return next;
    }
    if (sessionMode === 'standard') {
      return flattenScannerSession(captureReceipt(session, incoming));
    }
    // Batch is one long receipt: each capture is the next part of the receipt
    // being built, never a separate receipt.
    const target = session.receipts.at(-1);
    session = target
      ? addReceiptPage(session, target.localReceiptId, incoming)
      : captureReceipt(session, incoming, incoming[0]?.receiptGroupId);
    const next = flattenScannerSession(session);
    assertWithinBatchCapacity(next);
    return next;
  }
  function chooseSessionMode(nextMode: ScannerSessionMode) {
    if (nextMode === sessionMode) return;
    const apply = (retained: ReceiptSection[]) => {
      nativeEpoch.current++;
      nativeAccepted.current = false;
      setMode('standard');
      setManualSections(false);
      setScanning(false);
      setCapturePending(false);
      setZoomRatio(1);
      setReplaceId(null);
      setCropping(false);
      setFiltersOpen(false);
      setCommand(current => ({ id: current.id + 1, type: 'reset' }));
      let normalized = retained;
      if (nextMode === 'batch' && retained.length > 0 && retained.every(section => !section.receiptGroupId)) {
        const groupId = newReceiptGroupId();
        normalized = retained.map(section => ({ ...section, receiptGroupId: groupId }));
      }
      const normalizedGroups = groupReceiptMembers(normalized);
      setSelectedId(nextMode === 'batch' && normalizedGroups.length >= batchReceiptLimit
        ? normalizedGroups.at(-1)?.[0]?.localId ?? null
        : null);
      if (normalized !== sections) setSections(normalized);
      dirty.current = normalized.length > 0;
      setSessionMode(nextMode);
      setScannerMessage(nextMode === 'batch'
        ? 'Long receipt: start at the top and capture it one part at a time. The whole receipt does not need to fit.'
        : 'Fit one receipt in the frame on a contrasting surface.');
      haptics.tapped();
    };
    const discardExcept = (retained: ReceiptSection[]) => {
      const retainedIds = new Set(retained.map(section => section.localId));
      const retainedUris = protectedCacheUris(retained);
      for (const localId of filterSources.current.keys()) {
        if (!retainedIds.has(localId)) filterSources.current.delete(localId);
      }
      for (const localId of filterSelections.current.keys()) {
        if (!retainedIds.has(localId)) filterSelections.current.delete(localId);
      }
      const discarded = [...scannerFileLifecycle.created].filter(uri => !retainedUris.has(uri));
      releaseCreatedUris(discarded);
      apply(retained);
    };
    if (sections.length === 0) {
      apply([]);
      return;
    }
    if (nextMode === 'batch') {
      Alert.alert(
        'Scan a long receipt?',
        'Batch captures one long receipt in parts. Keep this photo as the first part, or start empty.',
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Keep as part 1', onPress: () => apply(sections) },
          {
            text: 'Start empty',
            style: 'destructive',
            onPress: () => discardExcept([]),
          },
        ],
      );
      return;
    }
    const firstReceipt = receiptGroups[0] ?? [];
    Alert.alert(
      'Switch to Standard?',
      receiptGroups.length > 1
        ? 'Standard keeps one receipt. You can keep the first receipt or discard the rest.'
        : sections.length > 1
          ? 'Standard is for a receipt that fits in one photo. Keep these parts together as one receipt, or start empty.'
          : 'Keep this receipt in Standard, or start with an empty capture.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: receiptGroups.length > 1 ? 'Keep first receipt' : 'Keep receipt', onPress: () => discardExcept(firstReceipt) },
        { text: receiptGroups.length > 1 ? 'Discard batch' : 'Start empty', style: 'destructive', onPress: () => discardExcept([]) },
      ],
    );
  }
  /** Tracks session-created cache copies; late copies are deleted after unmount. */
  function trackCacheCopy(uri: string, source?: string): string {
    if (uri === source) return uri;
    if (mounted.current) scannerFileLifecycle.created.add(uri);
    else void deleteReceiptScannerFiles([uri]);
    return uri;
  }
  const formFor = (uri: string, mimeType: string) => {
    const extension = mimeType === 'image/png' ? 'png' : mimeType === 'image/webp' ? 'webp' : 'jpg';
    const form = new FormData();
    form.append('file', { uri, name: `receipt.${extension}`, type: mimeType } as any);
    return form;
  };

  async function capture() {
    if (!camera.current || !ready || !active || full) return;
    await run(async (isCurrent) => {
      const photo = await camera.current!.takePictureAsync({ quality: CAPTURE_QUALITY, skipProcessing: false });
      if (!isCurrent()) return;
      if (!photo) throw new Error('The camera did not return a photo. Please try again.');
      trackCacheCopy(photo.uri);
      const section = {
        ...createReceiptSection(photo, 'manual-camera'),
        captureMode: 'standard' as const,
        ...(sessionMode === 'batch' && !replaceId ? { receiptGroupId: newReceiptGroupId() } : null),
      };
      const next = mergeCapturedSections(sections, [section], replaceId);
      if (!replaceId && next.length === sections.length) {
        throw new Error('This receipt is already in the batch. Capture a different receipt.');
      }
      if (sessionMode === 'batch') {
        stageBatchCapture(next, replaceId ?? section.localId, replaceId);
      } else {
        put(next);
        setSelectedId(replaceId ?? section.localId);
        setReady(false);
        setReplaceId(null);
      }
      haptics.committed();
    });
  }
  async function gallery() {
    if (full || (sessionMode === 'standard' && continuous && sections.length > 0 && !replaceId)) return;
    nativeEpoch.current++;
    await run(async (isCurrent) => {
      setPickerOpen(true); setTorch(false); setReady(false);
      try {
        const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: CAPTURE_QUALITY,
          allowsMultipleSelection: false,
          selectionLimit: 1 });
        if (!isCurrent() || result.canceled) return;
        // Normalize gallery formats (including HEIC) and orientation to JPEG.
        // The normalized full image is retained unchanged through later crops.
        const incoming: ReceiptSection[] = [];
        const seen = new Set<string>();
        for (const asset of result.assets) {
          if (seen.has(asset.uri)) continue; seen.add(asset.uri);
          if (result.assets.length > 1) throw new Error('Choose one photo to review at a time.');
          const jpg = await Manipulator.manipulateAsync(asset.uri, [], { compress: CAPTURE_QUALITY, format: Manipulator.SaveFormat.JPEG });
          trackCacheCopy(jpg.uri);
          incoming.push({
            ...createReceiptSection(jpg, 'gallery'),
            sourceAssetUri: asset.uri,
            captureMode: 'standard',
            ...(sessionMode === 'batch' && !replaceId ? { receiptGroupId: newReceiptGroupId() } : null),
          });
        }
        if (!isCurrent() || !incoming.length) return;
        const next = mergeCapturedSections(sections, incoming, replaceId);
        if (!replaceId && next.length === sections.length) throw new Error('These photos are already in this receipt. Choose a different section.');
        const pageId = replaceId
          ?? next.find(section => incoming.some(candidate => candidate.localId === section.localId))?.localId
          ?? next[0]?.localId;
        if (!pageId) throw new Error('The selected photo could not be added. Choose it again.');
        if (sessionMode === 'batch') {
          stageBatchCapture(next, pageId, replaceId);
        } else {
          put(next);
          setSelectedId(pageId);
          setReplaceId(null);
        }
      } finally { if (isCurrent()) setPickerOpen(false); }
    });
  }
  // ANALYSIS-ONLY DOWNSCALE. /quality-check returns a verdict, not an image,
  // and resizes to width 400 before it looks at anything — so the full-resolution
  // JPEG this used to send was megabytes the server decoded and discarded. The
  // page itself is untouched; only the copy on the wire is smaller.
  async function checkQuality() {
    if (!selected) return;
    await run(async (isCurrent, signal) => {
      const uri = trackCacheCopy(await analysisImageUri(selected.processedUri, selected.width, selected.height), selected.processedUri);
      if (!isCurrent()) return;
      const quality = await api.upload<SectionQuality>('/records/receipts/quality-check', formFor(uri, uri === selected.processedUri ? selected.processedMimeType ?? 'image/jpeg' : 'image/jpeg'), signal);
      if (isCurrent()) updateSection({ ...selected, quality });
    });
  }
  /**
   * Turns the page a quarter left. The filter base turns with it, so a later
   * filter still starts from the unenhanced crop instead of re-enhancing the
   * already-filtered pixels, and the chosen filter stays selected.
   */
  async function rotate() {
    if (!selected) return;
    const page = selected;
    const storedBaseUri = filterSources.current.get(page.localId)?.processedUri;
    const baseUri = storedBaseUri ?? page.filterSourceUri;
    await run(async (isCurrent) => {
      const turn = [{ rotate: -90 }];
      const result = await Manipulator.manipulateAsync(page.processedUri, turn, { compress: CAPTURE_QUALITY, format: Manipulator.SaveFormat.JPEG });
      trackCacheCopy(result.uri);
      const base = baseUri && baseUri !== page.processedUri
        ? await Manipulator.manipulateAsync(baseUri, turn, { compress: CAPTURE_QUALITY, format: Manipulator.SaveFormat.JPEG })
        : undefined;
      if (base) trackCacheCopy(base.uri);
      if (!isCurrent()) return;
      const rotatedBaseUri = base?.uri ?? (baseUri ? result.uri : undefined);
      filterSources.current.delete(page.localId);
      if (!rotatedBaseUri) filterSelections.current.delete(page.localId);
      const nextSection = { ...page, filterSourceUri: rotatedBaseUri, processedUri: result.uri, width: result.width, height: result.height,
        processedMimeType: 'image/jpeg', processingMode: rotatedBaseUri ? page.processingMode ?? 'original' : 'manual-crop' as const,
        transformVersion: `${page.transformVersion ?? 'original'}-l90`.slice(-80), cropOutcome: undefined, quality: null };
      const next = sections.map(section => section.localId === nextSection.localId ? nextSection : section);
      put(next);
      releaseCreatedUris([page.processedUri, page.filterSourceUri, storedBaseUri]);
    });
  }
  async function filterReceipt(filterMode: ReceiptFilterMode) {
    if (!selected) return;
    const base = filterSources.current.get(selected.localId) ?? {
      processedUri: filterSourceUri(selected) ?? selected.processedUri,
      processedMimeType: filterSourceUri(selected) ? 'image/jpeg' : selected.processedMimeType,
      processingMode: filterSourceUri(selected) ? 'manual-crop' as const : selected.processingMode,
      transformVersion: selected.transformVersion,
      width: selected.width,
      height: selected.height,
    };
    filterSources.current.set(selected.localId, base);
    if (filterMode === 'original') {
      filterSelections.current.set(selected.localId, filterMode);
      const nextSection = {
        ...selected,
        ...base,
        quality: null,
      };
      const next = sections.map(section => section.localId === nextSection.localId ? nextSection : section);
      put(next);
      releaseCreatedUris([selected.processedUri]);
      return;
    }
    await run(async (isCurrent) => {
      const result = await applyReceiptFilter(base.processedUri, filterMode);
      trackCacheCopy(result.uri, base.processedUri);
      if (!isCurrent()) return;
      const nextSection = {
        ...selected,
        processedUri: result.uri,
        processedMimeType: 'image/jpeg',
        width: result.width,
        height: result.height,
        processingMode: result.processingMode,
        transformVersion: result.transformVersion,
        quality: null,
      };
      const next = sections.map(section => section.localId === nextSection.localId ? nextSection : section);
      put(next);
      filterSelections.current.set(selected.localId, filterMode);
      releaseCreatedUris([selected.processedUri]);
      haptics.committed();
    });
  }
  async function detect(): Promise<Corners | null> {
    if (!selected || locked.current) return null;
    let corners: Corners | null = null;
    await run(async (isCurrent, signal) => {
      // Same downscale as checkQuality, and safe for the SAME reason plus one
      // more: /detect-edges resizes to width 320, and it answers in FRACTIONS
      // of the frame, which `cornersFromFractions` then scales back against the
      // full-resolution original. The crop that follows still runs on the
      // untouched original — see applyCrop.
      const width = selected.originalWidth ?? selected.width;
      const height = selected.originalHeight ?? selected.height;
      const uri = trackCacheCopy(await analysisImageUri(selected.originalUri, width, height), selected.originalUri);
      if (!isCurrent()) return;
      const result = await api.upload<{ corners: Corners | null; confidence: number }>('/records/receipts/detect-edges', formFor(uri, uri === selected.originalUri ? selected.originalMimeType ?? 'image/jpeg' : 'image/jpeg'), signal);
      if (!isCurrent()) return;
      corners = cornersFromFractions(result.corners, width, height);
      if (!corners) setError('No clear receipt boundary found. Place the corners manually.');
    }); return corners;
  }
  async function applyCrop(corners: Corners) {
    if (!selected) return;
    const priorBaseUri = filterSources.current.get(selected.localId)?.processedUri;
    await run(async (isCurrent, signal) => {
      const form = formFor(selected.originalUri, selected.originalMimeType ?? 'image/jpeg'); form.append('corners', JSON.stringify(corners));
      // CropEditor already refuses to send a quad the server would reject (see
      // lib/cropQuad.ts), so a 400 here is drift or an unusable photo — either
      // way the owner needs an instruction, not the endpoint's own wording.
      const result = await api.upload<{ base64: string; width: number; height: number; transformVersion: string }>('/records/receipts/transform', form, signal)
        .catch((e: unknown) => { throw new Error(transformFailureMessage(e instanceof ApiError ? e.status : undefined, e instanceof Error ? e.message : undefined)); });
      if (!isCurrent()) return;
      // Convert the response into a local cache URI; never retain base64 in session state.
      const image = await Manipulator.manipulateAsync(`data:image/jpeg;base64,${result.base64}`, [], { format: Manipulator.SaveFormat.JPEG, compress: CAPTURE_QUALITY });
      trackCacheCopy(image.uri);
      if (!isCurrent()) return;
      // A manual crop is enhanced like an automatic one: the straightened photo
      // becomes the filter base and the page's filter (Enhanced unless the
      // owner chose otherwise) is applied on this phone. If that fails, the
      // straightened photo is kept as it is.
      const chosen = filterSelections.current.get(selected.localId) ?? initialFilterMode(selected);
      const filterMode: ReceiptFilterMode = chosen === 'original' && !filterSelections.current.has(selected.localId) ? 'enhanced' : chosen;
      let processed = { uri: image.uri, width: image.width, height: image.height, processingMode: 'manual-crop' as ReceiptSection['processingMode'], transformVersion: result.transformVersion };
      if (localFilters && filterMode !== 'original') {
        try {
          const filtered = await applyReceiptFilter(image.uri, filterMode);
          trackCacheCopy(filtered.uri, image.uri);
          processed = filtered;
        } catch { /* Keep the straightened photo without a filter. */ }
        if (!isCurrent()) return;
      }
      filterSources.current.delete(selected.localId);
      if (localFilters) filterSelections.current.set(selected.localId, filterMode);
      else filterSelections.current.delete(selected.localId);
      const nextSection = { ...selected, filterSourceUri: localFilters ? image.uri : undefined, processedUri: processed.uri, width: processed.width, height: processed.height,
        processedMimeType: 'image/jpeg', cropCorners: corners, cropOutcome: undefined, processingMode: processed.processingMode, transformVersion: processed.transformVersion, quality: null };
      const next = sections.map(section => section.localId === nextSection.localId ? nextSection : section);
      put(next);
      releaseCreatedUris([selected.processedUri, selected.filterSourceUri, priorBaseUri]);
      setCropping(false);
    });
  }
  const readyToReview = sessionMode === 'standard' && sections.length > 0 && !selected && !replaceId;
  // `useCameraPermissions` answers null until its first async status read
  // resolves. That is not "denied" — asking for permission during it shows a
  // call to action for something the owner may have granted months ago.
  const permissionPending = permission === null;
  const startingCamera = permissionPending && active && !pickerOpen && !cameraError;
  const showCamera = permission?.granted && active && !selected && !readyToReview && !pickerOpen && !cameraError;
  const nativeShouldShow = Boolean(showCamera && !busy && !full && (sessionMode === 'batch' || nativeManual || !sections.length || replaceId));
  // Set after commit, never during render: a render React throws away (Strict
  // Mode, a concurrent retry) would otherwise leave the native event handlers
  // gating on a value from a frame that never existed.
  useEffect(() => { nativeVisible.current = nativeShouldShow; }, [nativeShouldShow]);
  function endCaptureWait() {
    captureRequestEpoch.current = null;
    if (captureWatchdog.current) { clearTimeout(captureWatchdog.current); captureWatchdog.current = null; }
  }
  function acceptNative(value: unknown) {
    endCaptureWait();
    if (!mounted.current || eventEpoch !== nativeEpoch.current || !nativeVisible.current || locked.current || nativeAccepted.current || full || (mode === 'long' && !nativeManual && !longStarted.current)) return;
    try {
      const received = receiptSectionFromNative(value);
      const section: ReceiptSection = {
        ...received,
        captureMode: 'standard',
        ...(sessionMode === 'batch' && !replaceId ? { receiptGroupId: newReceiptGroupId() } : null),
      };
      // A result for a mode the owner is no longer in is never adopted. Clear the
      // transient scanning/processing flags too, or the primary action stays
      // locked on "Finishing…" with nothing left to finish it.
      if (section.captureMode !== mode) { nativeEpoch.current++; longStarted.current = false; autoLongRequested.current = false; setScanning(false); setNativeProcessing(false); setCommand(c => ({ id: c.id + 1, type: 'reset' })); return; }
      const replacing = replaceId;
      const next = mergeCapturedSections(sections, [section], replacing);
      if (!replacing && next.length === sections.length) {
        nativeEpoch.current++;
        nativeAccepted.current = false;
        setCapturePending(false);
        setNativeProcessing(false);
        setScannerMessage('That image was already captured. Position a different receipt.');
        setCommand(current => ({ id: current.id + 1, type: 'reset' }));
        return;
      }
      nativeAccepted.current = true;
      scannerFileLifecycle.created.add(section.originalUri);
      scannerFileLifecycle.created.add(section.processedUri);
      if (section.filterSourceUri) scannerFileLifecycle.created.add(section.filterSourceUri);
      if (sessionMode === 'batch') {
        stageBatchCapture(next, replacing ?? section.localId, replacing);
      } else {
        put(next);
        setSelectedId(replacing ?? section.localId);
        setReplaceId(null);
      }
      nativeEpoch.current++; longStarted.current = false; autoLongRequested.current = false;
      setScanning(false); setCapturePending(false); setNativeProcessing(false); setTorch(false);
      haptics.committed();
    } catch (e) { nativeEpoch.current++; longStarted.current = false; autoLongRequested.current = false; setCommand(c => ({ id: c.id + 1, type: 'reset' })); setError(e instanceof Error ? e.message : 'Please scan again.'); setNativeProcessing(false); setScanning(false); }
  }
  function requestNativeCapture() {
    const epoch = nativeEpoch.current;
    endCaptureWait();
    captureRequestEpoch.current = epoch;
    captureWatchdog.current = setTimeout(() => {
      captureWatchdog.current = null;
      if (!mounted.current || captureRequestEpoch.current !== epoch || nativeEpoch.current !== epoch) return;
      captureRequestEpoch.current = null;
      nativeEpoch.current++;
      setCapturePending(false);
      setNativeProcessing(false);
      setCommand(c => ({ id: c.id + 1, type: 'reset' }));
      setScannerMessage('The photo took too long. Hold the phone steady and tap the shutter again.');
    }, 15000);
    setCapturePending(true);
    setCommand(c => ({ id: c.id + 1, type: 'capture' }));
    haptics.tapped();
  }
  function nativeAction() {
    if (!showCamera || full || nativeProcessing || capturePending) return;
    setError(null);
    if (mode === 'long' && !nativeManual) {
      if (!scanning) return;
      setCapturePending(true);
      setCommand(c => ({ id: c.id + 1, type: 'capture' }));
      haptics.tapped();
      return;
    }
    // The shutter always takes the photo. Cropping to the visible receipt
    // happens on the saved still, so missing edges never block it.
    setScannerMessage('Taking the photo…');
    requestNativeCapture();
  }
  function removeSelected() {
    if (!selected) return;
    if (stagedSelected) {
      discardStagedCapture();
      return;
    }
    const removingPageOnly = Boolean(selectedGroup && selectedGroup.length > 1);
    const removed = removingPageOnly ? [selected] : selectedGroup ?? [selected];
    const removedIds = new Set(removed.map(section => section.localId));
    const removedUris = removed.flatMap(section => [
      section.originalUri,
      section.processedUri,
      section.filterSourceUri,
      filterSources.current.get(section.localId)?.processedUri,
    ]);
    removedIds.forEach(id => {
      filterSources.current.delete(id);
      filterSelections.current.delete(id);
    });
    nativeAccepted.current = false;
    setCommand(current => ({ id: current.id + 1, type: 'reset' }));
    const next = sections.filter(section => !removedIds.has(section.localId));
    setSections(next);
    releaseCreatedUris(removedUris);
    dirty.current = next.length > 0;
    setFiltersOpen(false);
    const nextGroups = groupReceiptMembers(next);
    if (removingPageOnly) {
      const remainingGroup = nextGroups[selectedGroupIndex];
      setSelectedId(remainingGroup?.[Math.min(selectedPageIndex, remainingGroup.length - 1)]?.localId ?? null);
    } else {
      setSelectedId(sessionMode === 'batch' ? nextGroups[Math.min(selectedGroupIndex, nextGroups.length - 1)]?.[0]?.localId ?? null : null);
    }
    if (sessionMode === 'batch' && nextGroups.length === 0) {
      setScannerMessage('Start at the top of the receipt. The whole receipt does not need to fit.');
    }
    setReady(false);
  }
  function selectReceiptAt(index: number) {
    const receipt = receiptGroups[index];
    if (!receipt || (stagedBatch && !receipt.some(section => section.localId === stagedBatch.pageId))) return;
    setSelectedId(receipt[0]?.localId ?? null);
    setReplaceId(null);
    setOnAddSlot(false);
    setMoreOpen(false);
    setFiltersOpen(false);
    setError(null);
    setReady(false);
  }
  /** Selects a page by its position in the whole capture, across receipts. */
  function selectPage(index: number) {
    if (stagedBatch) return;
    const page = sections[clampPageIndex(index, sections.length)];
    if (!page) return;
    setSelectedId(page.localId);
    setOnAddSlot(false);
    setFiltersOpen(false);
    setMoreOpen(false);
    setError(null);
  }
  function addPage() {
    if (full || stagedBatch) return;
    nativeEpoch.current++;
    nativeAccepted.current = false;
    setSelectedId(null);
    setOnAddSlot(false);
    setFiltersOpen(false);
    setMoreOpen(false);
    setZoomRatio(1);
    setScannerMessage('Move down to the next part and keep a few lines of the last part in view.');
    setCommand(current => ({ id: current.id + 1, type: 'reset' }));
  }
  function retakeSelected() {
    if (!selected) return;
    nativeAccepted.current = false;
    autoLongRequested.current = false;
    setMode('standard');
    setManualSections(false);
    setCommand(current => ({ id: current.id + 1, type: 'reset' }));
    setReplaceId(selected.localId);
    setSelectedId(null);
    setOnAddSlot(false);
    setFiltersOpen(false);
    setMoreOpen(false);
    setReady(false);
  }
  function confirmDelete() {
    if (!selected) return;
    const deletingPage = Boolean(selectedGroup && selectedGroup.length > 1);
    const part = sessionMode === 'batch';
    Alert.alert(
      stagedSelected ? 'Discard this capture?' : deletingPage ? `Delete ${part ? 'part' : 'page'} ${selectedPageIndex + 1}?` : part ? 'Delete this part?' : 'Delete this receipt?',
      stagedSelected
        ? 'This photo has not been added to the receipt. Discard it and return to the camera?'
        : deletingPage
          ? part ? 'This removes this part of the long receipt. The other parts stay.' : 'This removes this page from the receipt. Other pages stay here.'
          : 'This removes the captured receipt and returns to the camera.',
      [{ text: stagedSelected ? 'Keep editing' : deletingPage ? `Keep ${part ? 'part' : 'page'}` : 'Keep receipt', style: 'cancel' }, { text: stagedSelected ? 'Discard' : 'Delete', style: 'destructive', onPress: removeSelected }],
    );
  }
  function resetSelectedImage() {
    if (!selected) return;
    const priorBaseUri = filterSources.current.get(selected.localId)?.processedUri;
    filterSources.current.delete(selected.localId);
    filterSelections.current.delete(selected.localId);
    const nextSection = { ...selected, filterSourceUri: undefined, processedUri: selected.originalUri, processedMimeType: selected.originalMimeType ?? 'image/jpeg', width: selected.originalWidth ?? selected.width, height: selected.originalHeight ?? selected.height, quality: null, cropCorners: undefined, cropOutcome: undefined, processingMode: 'original' as const, transformVersion: undefined };
    const next = sections.map(section => section.localId === nextSection.localId ? nextSection : section);
    put(next);
    releaseCreatedUris([selected.processedUri, selected.filterSourceUri, priorBaseUri]);
  }
  function moveSelectedReceipt(delta: -1 | 1) {
    if (stagedSelected || selectedGroupIndex < 0) return;
    const target = selectedGroupIndex + delta;
    if (target < 0 || target >= receiptGroups.length) return;
    const reordered = [...receiptGroups];
    const [moved] = reordered.splice(selectedGroupIndex, 1);
    if (!moved) return;
    reordered.splice(target, 0, moved);
    put(reordered.flat());
    haptics.tapped();
  }
  function moveSelectedPage(delta: -1 | 1) {
    if (stagedSelected || !selected || !selectedGroup || selectedPageIndex < 0) return;
    const reorderedGroup = moveSessionSection(selectedGroup, selected.localId, delta);
    if (reorderedGroup === selectedGroup) return;
    put(receiptGroups.map((group, index) => index === selectedGroupIndex ? reorderedGroup : group).flat());
    haptics.tapped();
  }
  function approveSections() {
    if (stagedBatch) {
      setError('Keep or discard the current receipt before finishing the batch.');
      return;
    }
    if (locked.current || handoffLatched.current || submitting || sections.length === 0) return;
    locked.current = true;
    setSubmitting(true);
    setError(null);
    try {
      const retained = new Set(sections.flatMap(section => [
        section.originalUri,
        section.processedUri,
        section.filterSourceUri,
      ].filter((uri): uri is string => typeof uri === 'string')));
      void deleteReceiptScannerFiles([...scannerFileLifecycle.created].filter(uri => !retained.has(uri)));
      handoffLatched.current = true;
      scannerFileLifecycle.handedOff = true;
      onDone(sections);
    } catch (e) {
      handoffLatched.current = false;
      scannerFileLifecycle.handedOff = false;
      locked.current = false;
      setSubmitting(false);
      setError(e instanceof Error ? e.message : 'Could not continue with these receipts. Try again.');
      haptics.failed();
    }
  }
  const hint = qualityHint(selected?.quality ?? null);
  const cropOutcomeHint = selected?.cropOutcome === 'original-fallback'
    ? 'Receipt edges were not found, so the full photo was kept. Use Crop to adjust it, or Retake.'
    : selected?.cropOutcome === 'visible-section'
      ? 'Cropped to the part of the receipt in the photo. Check that no text is cut off.'
      : null;
  const ink = { color: t.onCamera };
  const selectedIndex = selected ? sections.findIndex(section => section.localId === selected.localId) : -1;
  const addSlotOffered = showAddPageSlot(sessionMode, full, Boolean(stagedBatch));
  const onAddCard = onAddSlot && addSlotOffered;
  const confirmAction = reviewConfirmAction(sessionMode, stagedSelected);
  const confirmLabel = confirmAction === 'keep-page'
    ? 'Keep part'
    : confirmAction === 'finish-batch'
      ? receiptGroups.length > 1 ? `Finish batch (${readyReceiptCount})` : `Finish receipt (${keptPartCount} ${keptPartCount === 1 ? 'part' : 'parts'})`
      : 'Use this receipt';
  const working = busy || capturePending || nativeProcessing;
  const cameraMessage = nativeProcessing
    ? 'Cropping and enhancing the photo…'
    : replaceId
      ? 'Retake this receipt. It keeps its place in the batch.'
      : !nativeScannerAvailable && sections.length === 0 && !error
        ? isCustomScannerOutdated()
          ? 'This installed app has an older scanner, so automatic cropping is off. Take the photo and use Crop. Reinstall the app to turn it back on.'
          : 'Take the photo, then use Crop to trim it. Automatic cropping is not in this build.'
        : scannerMessage;
  const title = cropping ? 'Crop receipt' : selected ? sessionMode === 'batch' ? 'Long receipt' : 'Review receipt' : readyToReview ? 'Receipt ready' : null;
  const subtitle = selected && !cropping
    ? sessionMode === 'batch' && receiptGroups.length === 1
      ? `Part ${selectedPageIndex + 1} of ${selectedGroup?.length ?? 1}, top to bottom`
      : selectedGroup && selectedGroup.length > 1
      ? `Receipt ${selectedGroupIndex + 1}, page ${selectedPageIndex + 1} of ${selectedGroup.length}`
      : sessionStartedAt.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
    : null;
  const lastReceipt = receiptGroups.at(-1)?.at(-1);
  return <View style={[styles.root, { backgroundColor: t.cameraSurface, paddingTop: insets.top, paddingBottom: Math.max(insets.bottom, 8) }]}>
    <View key={`header-${fontScale}-${textLayoutRevision}`} style={styles.header}>
      <CameraAction iconOnly label={cropping || selected ? 'Back' : 'Close'} icon={cropping || selected ? 'arrow-back' : 'close-outline'} onPress={close} />
      {title ? <View style={styles.titleBlock}>
        <Text accessibilityRole="header" numberOfLines={1} style={[styles.heading, ink]}>{title}</Text>
        {subtitle ? <Text numberOfLines={1} style={[styles.small, styles.subtitle, ink]}>{subtitle}</Text> : null}
      </View> : <View style={styles.titleBlock} />}
      {selected && !cropping
        ? <CameraAction iconOnly label={moreOpen ? 'Close more actions' : 'More actions'} icon="ellipsis-horizontal" onPress={() => { setFiltersOpen(false); setMoreOpen(open => !open); }} disabled={busy} />
        : !selected && !readyToReview && !cropping ? <>
          {nativeViewActive ? <Pressable accessibilityRole="button" accessibilityLabel={`Zoom ${zoomRatio === 1 ? '1x' : '2x'}. Switch to ${zoomRatio === 1 ? '2x' : '1x'}`}
            accessibilityState={{ disabled: busy || nativeProcessing || capturePending || maxZoomRatio === null || maxZoomRatio < 2 }}
            disabled={busy || nativeProcessing || capturePending || maxZoomRatio === null || maxZoomRatio < 2}
            onPress={() => {
              nativeEpoch.current++;
              nativeAccepted.current = false;
              setZoomRatio(zoomRatio === 1 ? 2 : 1);
              setCommand(current => ({ id: current.id + 1, type: 'reset' }));
              haptics.tapped();
            }}
            style={({ pressed }) => [styles.zoom, { minWidth: TAP_FLOOR, minHeight: TAP_FLOOR, opacity: busy || nativeProcessing || capturePending || maxZoomRatio === null || maxZoomRatio < 2 ? 0.45 : pressed ? 0.65 : 1 }]}>
            <View style={[styles.zoomFace, { borderColor: t.onCamera }]}><Text style={[styles.zoomText, ink]}>{zoomRatio}x</Text></View>
          </Pressable> : null}
          <CameraAction iconOnly label={torch ? 'Flash on' : 'Flash off'} icon={torch ? 'flash' : 'flash-off-outline'} onPress={() => setTorch(!torch)} disabled={!showCamera || busy || capturePending || nativeProcessing} />
        </> : <View style={{ width: 48 }} />}
    </View>
    {error ? <Text accessibilityRole="alert" style={[styles.notice, ink]}>{error}</Text> : null}
    {cropping && selected ? <CropEditor key={selected.localId} uri={selected.originalUri} width={selected.originalWidth ?? selected.width} height={selected.originalHeight ?? selected.height} initial={selected.cropCorners} busy={busy} onApply={corners => void applyCrop(corners)} onCancel={() => setCropping(false)} onDetect={detect} />
      : selected ? <>
        <PageReviewer noun={sessionMode === 'batch' ? 'part' : 'page'} pages={sections} index={Math.max(0, selectedIndex)} onAddSlot={onAddCard} showAddPage={addSlotOffered} locked={Boolean(stagedBatch)} busy={busy}
          hint={cropOutcomeHint ?? hint ?? (selected.quality ? 'Quality checked. Make sure every line is readable.' : null)}
          onSelectPage={selectPage} onAddSlotChange={visible => { setOnAddSlot(visible); setFiltersOpen(false); setMoreOpen(false); }} onAddPage={addPage} onDeletePage={confirmDelete} />
        {filtersOpen ? <ReceiptFilterSheet value={filterSelections.current.get(selected.localId) ?? initialFilterMode(selected)} busy={busy} onSelect={filterMode => void filterReceipt(filterMode)} onClose={() => setFiltersOpen(false)} /> : null}
        {moreOpen ? <View key={`more-${fontScale}-${textLayoutRevision}`} style={styles.more}>
          <View style={styles.row}>
            <CameraAction label="Check quality" icon="checkmark-circle-outline" onPress={() => void checkQuality()} disabled={busy} />
            {selected.processedUri !== selected.originalUri ? <CameraAction label="Reset image" icon="return-up-back-outline" onPress={resetSelectedImage} disabled={busy} /> : null}
            {sessionMode === 'batch' && receiptGroups.length > 1 && !stagedBatch ? <>
              <CameraAction label="Move earlier" icon="arrow-back" onPress={() => moveSelectedReceipt(-1)} disabled={busy || selectedGroupIndex <= 0} />
              <CameraAction label="Move later" icon="arrow-forward" onPress={() => moveSelectedReceipt(1)} disabled={busy || selectedGroupIndex >= receiptGroups.length - 1} />
            </> : null}
            {selectedGroup && selectedGroup.length > 1 ? <>
              <CameraAction label={sessionMode === 'batch' ? 'Move part up' : 'Move page earlier'} icon="arrow-back" onPress={() => moveSelectedPage(-1)} disabled={busy || stagedSelected || selectedPageIndex <= 0} />
              <CameraAction label={sessionMode === 'batch' ? 'Move part down' : 'Move page later'} icon="arrow-forward" onPress={() => moveSelectedPage(1)} disabled={busy || stagedSelected || selectedPageIndex >= selectedGroup.length - 1} />
            </> : null}
          </View>
          <Text style={[styles.small, ink]}>{localFilters ? 'Filters run on this phone. Crop and Check quality send this photo to FinSight for processing. Nothing is saved to your records until you confirm the scan.' : 'Crop and Check quality send this photo to FinSight for processing. Nothing is saved to your records until you confirm the scan.'}</Text>
        </View> : null}
        <ReviewToolbar busy={busy} editsDisabled={onAddCard} showFilter={localFilters} confirmLabel={confirmLabel}
          confirmCount={confirmAction === 'finish-batch' ? receiptGroups.length > 1 ? readyReceiptCount : keptPartCount : undefined}
          confirmDisabled={busy || submitting || (confirmAction !== 'keep-page' && readyReceiptCount === 0)}
          onRetake={retakeSelected} onRotate={() => void rotate()} onFilter={() => { setMoreOpen(false); setFiltersOpen(open => !open); }} onCrop={() => { setFiltersOpen(false); setMoreOpen(false); setCropping(true); }}
          onConfirm={confirmAction === 'keep-page' ? confirmStagedCapture : approveSections} />
      </> : <>
      <View style={styles.viewfinder}>
        {readyToReview ? <Image accessible accessibilityRole="image" accessibilityLabel="Receipt awaiting review" source={{ uri: sections[0]!.processedUri }} style={StyleSheet.absoluteFill} resizeMode="contain" /> : showCamera ? <>
          {nativeViewActive && NativeScanner ? <NativeScanner key={`${sessionMode}-${nativeInteractionMode}-${replaceId ?? 'new'}`} style={StyleSheet.absoluteFill} active={!busy && !full && (sessionMode === 'batch' || nativeManual || !sections.length || Boolean(replaceId))} mode={nativeInteractionMode} autoCapture={nativeAutoCapture} torch={torch} zoomRatio={zoomRatio} command={command}
            onStatus={event => { if (!mounted.current || eventEpoch !== nativeEpoch.current || !nativeVisible.current) return; const status = parseScannerStatus(event.nativeEvent); if (status) {
              setScannerMessage(status.message); setNativeProcessing(status.state === 'processing');
              if (status.maxZoomRatio !== undefined) setMaxZoomRatio(status.maxZoomRatio);
              if (mode === 'long' && !manualSections && status.state === 'ready' && !autoLongRequested.current) {
                autoLongRequested.current = true; longStarted.current = true;
                setCapturePending(false); setScanning(true);
                setScannerMessage('Finding the top edge. Hold the phone steady.');
                setCommand(c => ({ id: c.id + 1, type: 'start' }));
              }
              if (longStarted.current && status.state !== 'capturing' && status.state !== 'processing') setCapturePending(false);
              const waitingForPhoto = captureRequestEpoch.current !== null && captureRequestEpoch.current === nativeEpoch.current;
              if ((mode === 'standard' || nativeManual) && !waitingForPhoto
                && (status.state === 'ready' || status.state === 'searching' || status.state === 'quality')) {
                setCapturePending(false);
              }
            } }}
            onCapture={event => acceptNative(event.nativeEvent)}
            onError={event => { if (!mounted.current || eventEpoch !== nativeEpoch.current || !nativeVisible.current) return; endCaptureWait(); nativeEpoch.current++; longStarted.current = false; autoLongRequested.current = false; const data = event.nativeEvent as { message?: unknown } | null; setError(typeof data?.message === 'string' ? data.message.slice(0, 300) : 'Scanning failed. Try again or choose a gallery image.'); setScanning(false); setCapturePending(false); setNativeProcessing(false); setCommand(c => ({ id: c.id + 1, type: 'reset' })); }} /> : <CameraView ref={camera} style={StyleSheet.absoluteFill} facing="back" mode="picture" enableTorch={torch} animateShutter
            onCameraReady={() => setReady(true)} onMountError={() => { setCameraError(true); setReady(false); setError('The camera could not start. Retry it or choose a photo from your gallery.'); }} />
          }
          {!nativeViewActive && !ready ? <ActivityIndicator accessibilityLabel="Starting camera" size="large" color={t.onCamera} /> : null}
          <CaptureStatusPill key={`pill-${fontScale}-${textLayoutRevision}`} message={cameraMessage} working={nativeProcessing} />
        </> : <View style={styles.empty} accessibilityLiveRegion="polite" {...(startingCamera ? { accessible: true, accessibilityRole: 'progressbar' as const, accessibilityLabel: 'Starting camera' } : null)}>
          {/* The spinner, the neutral heading and NO call to action while the
              permission status is still being read: this state is reached on
              every open, including the ordinary already-granted one, and
              "Allow camera access" flashing there tells the owner their
              permission is missing when it is not. */}
          {startingCamera ? <ActivityIndicator size="large" color={t.onCamera} /> : <Ionicons name="camera-outline" size={44} color={t.onCamera} />}
          <Text style={[styles.heading, ink]}>{pickerOpen ? 'Choose receipt photos' : !active ? 'Camera paused' : cameraError ? 'Camera unavailable' : startingCamera ? 'Starting camera…' : 'Allow camera access'}</Text>
          <Text style={[styles.body, ink]}>{startingCamera ? 'Checking this phone’s camera permission.' : 'You can photograph a receipt or choose an existing image from your gallery.'}</Text>
          {!pickerOpen && active && !startingCamera ? <CameraAction primary label={cameraError ? 'Retry camera' : permission?.canAskAgain === false ? 'Open settings' : 'Allow camera'} onPress={() => {
            if (cameraError) { setCameraError(false); setError(null); }
            else if (permission?.canAskAgain === false) void Linking.openSettings().catch(() => setError('Open your phone settings to allow camera access.'));
            else void run(async () => { await requestPermission(); });
          }} disabled={busy} /> : null}
        </View>}
      </View>
      {/* Refresh native text measurements after accessibility-size changes without
          remounting the camera or discarding the retained receipt. */}
      <View key={`controls-${fontScale}-${textLayoutRevision}`} style={styles.bottom}>
        {readyToReview ? <>
          <Text style={[styles.body, ink]}>Your receipt is ready to review. It has not been saved to a record.</Text>
          <CameraAction primary label="Review receipt" icon="checkmark-outline" onPress={() => selectReceiptAt(0)} disabled={busy} />
        </> : <>
          <ScannerModeSelector value={sessionMode} disabled={busy || nativeProcessing || capturePending} onChange={chooseSessionMode} />
          <ShutterRow
            onGallery={() => void gallery()} galleryDisabled={busy || full || nativeProcessing || capturePending}
            onShutter={() => nativeViewActive ? nativeAction() : void capture()}
            shutterDisabled={busy || !showCamera || full || nativeProcessing || capturePending || (!nativeViewActive && !ready)}
            working={working && Boolean(showCamera)}
            reviewUri={lastReceipt?.processedUri} reviewCount={sessionMode === 'batch' && receiptGroups.length === 1 ? batchParts.length : receiptGroups.length}
            reviewNoun={sessionMode === 'batch' && receiptGroups.length === 1 ? 'part' : 'receipt'} showCount={sessionMode === 'batch'}
            onReview={() => sessionMode === 'batch' ? selectPage(sections.length - 1) : selectReceiptAt(receiptGroups.length - 1)} reviewDisabled={busy || nativeProcessing || capturePending} />
          {full ? <Text style={[styles.small, ink]}>{sessionMode === 'batch' ? `This receipt has ${MAX_SECTIONS} parts, the most one scan can hold. Open it to finish.` : 'Review this receipt before continuing.'}</Text> : null}
        </>}
        {busy && !selected ? <ActivityIndicator accessibilityLabel="Processing receipt photo" color={t.onCamera} /> : null}
      </View>
    </>}
  </View>;
}
const styles = StyleSheet.create({
  root: { flex: 1 }, header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 4, paddingVertical: 4, gap: 4 },
  titleBlock: { flex: 1, minWidth: 0 },
  heading: { fontFamily: font.display, fontSize: typeScale.title, textAlign: 'left' },
  subtitle: { textAlign: 'left', opacity: 0.8 },
  body: { fontFamily: font.sansMedium, fontSize: typeScale.bodySm, textAlign: 'center' },
  small: { fontFamily: font.sans, fontSize: typeScale.caption, textAlign: 'center' },
  notice: { fontFamily: font.sans, fontSize: typeScale.bodySm, paddingHorizontal: 16, paddingVertical: 8 },
  viewfinder: { flex: 1, minHeight: 120, overflow: 'hidden', justifyContent: 'center' },
  empty: { alignItems: 'center', padding: 24, gap: 16 }, bottom: { paddingTop: 8, paddingBottom: 4, gap: 10 },
  more: { gap: 8, paddingHorizontal: 12, paddingVertical: 8 },
  row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'center', gap: 8 },
  zoom: { alignItems: 'center', justifyContent: 'center' },
  zoomFace: { minWidth: 36, height: 30, borderRadius: 15, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 6 },
  zoomText: { fontFamily: font.sansSemibold, fontSize: typeScale.label },
});
