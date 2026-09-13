/** FinSight receipt capture: a full-screen lens with a thumb-reachable shutter,
 * gallery import and an ordered section strip. Uses the existing teal camera
 * palette. Originals survive every edit; pages leave only after approval.
 * Native long capture produces one panorama. Older builds retain an explicitly
 * manual section fallback; this must never be presented as continuous scanning.
 * The native paper highlight is preview-only. A growing thumbnail must show
 * accepted mosaic pixels, never elapsed-time or fabricated receipt progress.
 */
import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type ForwardedRef } from 'react';
import { ActivityIndicator, Alert, AppState, BackHandler, Image, Linking, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as ImagePicker from 'expo-image-picker';
import * as Manipulator from 'expo-image-manipulator';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../context/ThemeContext';
import { font, typeScale } from '../../theme/tokens';
import { ApiError, api } from '../../lib/api';
import { transformFailureMessage } from '../../lib/cropQuad';
import * as haptics from '../../lib/haptics';
import { CAPTURE_QUALITY, MAX_SECTIONS, cornersFromFractions, type Corners, type ReceiptSection, type SectionQuality } from '../../lib/receiptCapture';
import { addSessionSections, createReceiptSection, moveSessionSection, qualityHint, removeSessionSection } from '../../lib/receiptCameraSession';
import { analysisImageUri } from '../../lib/analysisImage';
import { USE_NATIVE_RECEIPT_CAMERA } from '../../lib/receiptScannerFeature';
import { NativeReceiptCamera } from './NativeReceiptCamera';
import { CameraAction } from './CameraAction';
import { CropEditor } from './CropEditor';
import { getCustomScannerView, parseScannerStatus, receiptSectionFromNative, type ScannerCommand } from '../../lib/customReceiptScanner';

export interface ReceiptCameraProps { initialSections?: ReceiptSection[]; onCancel: () => void; onDone: (sections: ReceiptSection[]) => void; }
export interface ReceiptCameraHandle { requestClose: () => void; }
export const ReceiptCamera = forwardRef<ReceiptCameraHandle, ReceiptCameraProps>(function ReceiptCamera(props, ref) {
  return USE_NATIVE_RECEIPT_CAMERA ? <NativeReceiptCamera {...props} /> : <CustomReceiptCamera {...props} handleRef={ref} />;
});

function CustomReceiptCamera({ initialSections = [], onCancel, onDone, handleRef }: ReceiptCameraProps & { handleRef: ForwardedRef<ReceiptCameraHandle> }) {
  const t = useTheme(); const insets = useSafeAreaInsets();
  const { fontScale } = useWindowDimensions();
  const NativeScanner = getCustomScannerView();
  const continuous = NativeScanner !== null;
  const [command, setCommand] = useState<ScannerCommand>({ id: 0, type: 'reset' });
  const [scanning, setScanning] = useState(false);
  const [hasAcceptedReceipt, setHasAcceptedReceipt] = useState(false);
  const [nativeProcessing, setNativeProcessing] = useState(false);
  const [scannerMessage, setScannerMessage] = useState('Position the receipt on a contrasting surface.');
  const nativeAccepted = useRef(false);
  const nativeVisible = useRef(false);
  const nativeEpoch = useRef(0);
  const longStarted = useRef(false);
  const eventEpoch = nativeEpoch.current;
  const [permission, requestPermission, getPermission] = useCameraPermissions();
  const [sections, setSections] = useState<ReceiptSection[]>(() => [...initialSections]);
  const [mode, setMode] = useState<'standard' | 'long'>(initialSections.length ? 'long' : 'standard');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [replaceId, setReplaceId] = useState<string | null>(null);
  const [cropping, setCropping] = useState(false);
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
  const [error, setError] = useState<string | null>(null);
  const [cameraError, setCameraError] = useState(false);
  const camera = useRef<CameraView>(null);
  const mounted = useRef(true); const locked = useRef(false); const version = useRef(0); const dirty = useRef(false);
  const operationAbort = useRef<AbortController | null>(null);
  const closeRef = useRef<() => void>(() => {});
  useImperativeHandle(handleRef, () => ({ requestClose: () => closeRef.current() }), []);
  const selected = sections.find(s => s.localId === selectedId);
  // Custom native evidence is rectified, but not enhanced; it is not the full
  // camera frame. Derive this from capture provenance so crop/rotate keep it.
  const selectedCustomScan = selected?.captureSource === 'native-document-scanner' && selected.captureMode !== undefined;
  const previous = sections.at(-1);
  const full = sections.length >= MAX_SECTIONS && !replaceId;

  useEffect(() => {
    mounted.current = true;
    const sub = AppState.addEventListener('change', state => {
      const foreground = state === 'active'; setActive(foreground);
      if (!foreground) { nativeEpoch.current++; longStarted.current = false; nativeVisible.current = false; setTorch(false); setReady(false); setScanning(false); setNativeProcessing(false); setCommand(c => ({ id: c.id + 1, type: 'reset' })); setScannerMessage('Camera paused. Position the receipt and start again.'); }
      else {
        // Android can update native font scaling before Dimensions reflects
        // it. Recreate only text/control hosts on return from Settings.
        setTextLayoutRevision((revision) => revision + 1);
        void getPermission().catch(() => undefined);
      }
    });
    const back = BackHandler.addEventListener('hardwareBackPress', () => { closeRef.current(); return true; });
    // This is an operation counter, not a host view ref; invalidate late captures.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    return () => { mounted.current = false; version.current++; operationAbort.current?.abort(); sub.remove(); back.remove(); };
  }, [getPermission]);

  function close() {
    if (scanning || nativeProcessing) {
      Alert.alert('Discard the current scan?', 'Your unfinished continuous scan will be lost. Previously reviewed images are kept.', [
        { text: 'Keep scanning', style: 'cancel' }, { text: 'Discard scan', style: 'destructive', onPress: () => { nativeEpoch.current++; longStarted.current = false; setCommand(c => ({ id: c.id + 1, type: 'reset' })); setScanning(false); setNativeProcessing(false); } },
      ]); return;
    }
    if (locked.current) {
      version.current++; operationAbort.current?.abort(); locked.current = false;
      setBusy(false); setPickerOpen(false); setError(null);
    }
    // Going back is the owner deciding not to hand these sections over after
    // all; the primary action must be usable again when they return to it.
    if (submitting) setSubmitting(false);
    if (cropping) { setCropping(false); return; }
    if (selected) { nativeEpoch.current++; setSelectedId(null); return; }
    if (replaceId) { nativeEpoch.current++; longStarted.current = false; setReplaceId(null); return; }
    if (dirty.current) Alert.alert('Discard this capture session?', 'Your captured sections have not been sent for scanning.', [
      { text: 'Keep editing', style: 'cancel' }, { text: 'Discard', style: 'destructive', onPress: onCancel },
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
  const formFor = (uri: string) => { const form = new FormData(); form.append('file', { uri, name: 'receipt.jpg', type: 'image/jpeg' } as any); return form; };

  async function capture() {
    if (!camera.current || !ready || !active || full) return;
    await run(async (isCurrent) => {
      const photo = await camera.current!.takePictureAsync({ quality: CAPTURE_QUALITY, skipProcessing: false });
      if (!isCurrent()) return;
      if (!photo) throw new Error('The camera did not return a photo. Please try again.');
      const section = { ...createReceiptSection(photo, 'manual-camera'), captureMode: mode };
      const next = addSessionSections(sections, [section], replaceId);
      put(next); setSelectedId(replaceId ?? section.localId); setReplaceId(null); setTorch(false); setReady(false); haptics.committed();
    });
  }
  async function gallery() {
    if (full || (continuous && sections.length > 0 && !replaceId)) return;
    nativeEpoch.current++;
    await run(async (isCurrent) => {
      setPickerOpen(true); setTorch(false); setReady(false);
      try {
        const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: CAPTURE_QUALITY,
          allowsMultipleSelection: !continuous && mode === 'long' && !replaceId, orderedSelection: true,
          selectionLimit: continuous || replaceId || mode === 'standard' ? 1 : MAX_SECTIONS - sections.length });
        if (!isCurrent() || result.canceled) return;
        // Normalize gallery formats (including HEIC) and orientation to JPEG.
        // The normalized full image is retained unchanged through later crops.
        const incoming: ReceiptSection[] = [];
        const seen = new Set<string>();
        for (const asset of result.assets) {
          if (seen.has(asset.uri)) continue; seen.add(asset.uri);
          if (result.assets.length > (replaceId ? 1 : MAX_SECTIONS - sections.length)) throw new Error(`Choose no more than ${replaceId ? 1 : MAX_SECTIONS - sections.length} photos.`);
          const jpg = await Manipulator.manipulateAsync(asset.uri, [], { compress: CAPTURE_QUALITY, format: Manipulator.SaveFormat.JPEG });
          incoming.push({ ...createReceiptSection(jpg, 'gallery'), sourceAssetUri: asset.uri, captureMode: mode });
        }
        if (!isCurrent() || !incoming.length) return;
        const next = addSessionSections(sections, incoming, replaceId);
        if (!replaceId && next.length === sections.length) throw new Error('These photos are already in this receipt. Choose a different section.');
        put(next); setSelectedId(replaceId ?? next.find(s => incoming.some(i => i.localId === s.localId))?.localId ?? next[0]?.localId ?? null); setReplaceId(null);
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
      const uri = await analysisImageUri(selected.processedUri, selected.width, selected.height);
      if (!isCurrent()) return;
      const quality = await api.upload<SectionQuality>('/records/receipts/quality-check', formFor(uri), signal);
      if (isCurrent()) updateSection({ ...selected, quality });
    });
  }
  async function rotate() {
    if (!selected) return;
    await run(async (isCurrent) => {
      const result = await Manipulator.manipulateAsync(selected.processedUri, [{ rotate: 90 }], { compress: CAPTURE_QUALITY, format: Manipulator.SaveFormat.JPEG });
      if (isCurrent()) updateSection({ ...selected, processedUri: result.uri, width: result.width, height: result.height,
        processingMode: 'manual-crop', transformVersion: `${selected.transformVersion ?? 'original'}-r90`.slice(-80), quality: null });
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
      const uri = await analysisImageUri(selected.originalUri, width, height);
      if (!isCurrent()) return;
      const result = await api.upload<{ corners: Corners | null; confidence: number }>('/records/receipts/detect-edges', formFor(uri), signal);
      if (!isCurrent()) return;
      corners = cornersFromFractions(result.corners, width, height);
      if (!corners) setError('No clear receipt boundary found. Place the corners manually.');
    }); return corners;
  }
  async function applyCrop(corners: Corners) {
    if (!selected) return;
    await run(async (isCurrent, signal) => {
      const form = formFor(selected.originalUri); form.append('corners', JSON.stringify(corners));
      // CropEditor already refuses to send a quad the server would reject (see
      // lib/cropQuad.ts), so a 400 here is drift or an unusable photo — either
      // way the owner needs an instruction, not the endpoint's own wording.
      const result = await api.upload<{ base64: string; width: number; height: number; transformVersion: string }>('/records/receipts/transform', form, signal)
        .catch((e: unknown) => { throw new Error(transformFailureMessage(e instanceof ApiError ? e.status : undefined, e instanceof Error ? e.message : undefined)); });
      if (!isCurrent()) return;
      // Convert the response into a local cache URI; never retain base64 in session state.
      const image = await Manipulator.manipulateAsync(`data:image/jpeg;base64,${result.base64}`, [], { format: Manipulator.SaveFormat.JPEG, compress: CAPTURE_QUALITY });
      if (!isCurrent()) return;
      updateSection({ ...selected, processedUri: image.uri, width: image.width, height: image.height,
        cropCorners: corners, processingMode: 'manual-crop', transformVersion: result.transformVersion, quality: null });
      setCropping(false);
    });
  }
  const readyToReview = continuous && sections.length > 0 && !selected && !replaceId;
  // `useCameraPermissions` answers null until its first async status read
  // resolves. That is not "denied" — asking for permission during it shows a
  // call to action for something the owner may have granted months ago.
  const permissionPending = permission === null;
  const startingCamera = permissionPending && active && !pickerOpen && !cameraError;
  const showCamera = permission?.granted && active && !selected && !readyToReview && !pickerOpen && !cameraError;
  const nativeShouldShow = Boolean(showCamera && !busy && (!sections.length || replaceId));
  // Set after commit, never during render: a render React throws away (Strict
  // Mode, a concurrent retry) would otherwise leave the native event handlers
  // gating on a value from a frame that never existed.
  useEffect(() => { nativeVisible.current = nativeShouldShow; }, [nativeShouldShow]);
  function acceptNative(value: unknown) {
    if (!mounted.current || eventEpoch !== nativeEpoch.current || !nativeVisible.current || locked.current || nativeAccepted.current || full || (mode === 'long' && !longStarted.current)) return;
    try {
      const section = receiptSectionFromNative(value);
      // A result for a mode the owner is no longer in is never adopted. Clear the
      // transient scanning/processing flags too, or the primary action stays
      // locked on "Finishing…" with nothing left to finish it.
      if (section.captureMode !== mode) { nativeEpoch.current++; longStarted.current = false; setScanning(false); setNativeProcessing(false); setCommand(c => ({ id: c.id + 1, type: 'reset' })); return; }
      nativeAccepted.current = true;
      put(addSessionSections(sections, [section], replaceId)); setSelectedId(replaceId ?? section.localId);
      nativeEpoch.current++; longStarted.current = false;
      setReplaceId(null); setScanning(false); setNativeProcessing(false); setTorch(false); haptics.committed();
    } catch (e) { nativeEpoch.current++; longStarted.current = false; setCommand(c => ({ id: c.id + 1, type: 'reset' })); setError(e instanceof Error ? e.message : 'Please scan again.'); setNativeProcessing(false); setScanning(false); }
  }
  function nativeAction() {
    if (!showCamera || full || nativeProcessing) return;
    setError(null);
    if (mode === 'long') {
      if (scanning && !hasAcceptedReceipt) return;
      if (!scanning) setHasAcceptedReceipt(false);
      longStarted.current = true;
      setCommand(c => ({ id: c.id + 1, type: scanning ? 'finish' : 'start' }));
      if (scanning) setNativeProcessing(true); else setScanning(true);
    } else {
      setScannerMessage('Checking receipt edges. Keep all four corners visible and hold still.');
      setCommand(c => ({ id: c.id + 1, type: 'capture' }));
      haptics.tapped();
    }
  }
  const hint = qualityHint(selected?.quality ?? null);
  const ink = { color: t.onCamera };
  return <View style={[styles.root, { backgroundColor: t.cameraSurface, paddingTop: insets.top, paddingBottom: Math.max(insets.bottom, 12) }]}>
    <View key={`header-${fontScale}-${textLayoutRevision}`} style={styles.header}>
      <CameraAction iconOnly label={cropping || selected ? 'Back' : 'Close'} icon={cropping || selected ? 'arrow-back' : 'close-outline'} onPress={close} />
      <Text accessibilityRole="header" numberOfLines={1} style={[styles.heading, ink]}>{cropping ? 'Crop receipt' : selected ? continuous && sections.length === 1 ? 'Review receipt' : `Section ${sections.indexOf(selected) + 1}` : readyToReview ? 'Receipt ready' : 'Scan receipt'}</Text>
      {!selected && !readyToReview ? <CameraAction iconOnly label={torch ? 'Flash on' : 'Flash off'} icon={torch ? 'flash' : 'flash-off-outline'} onPress={() => setTorch(!torch)} disabled={!showCamera || busy} /> : <View style={{ width: 48 }} />}
    </View>
    {error ? <Text accessibilityRole="alert" style={[styles.notice, ink]}>{error}</Text> : null}
    {cropping && selected ? <CropEditor key={selected.localId} uri={selected.originalUri} width={selected.originalWidth ?? selected.width} height={selected.originalHeight ?? selected.height} initial={selected.cropCorners} busy={busy} onApply={corners => void applyCrop(corners)} onCancel={() => setCropping(false)} onDetect={detect} /> : <>
      <View style={styles.viewfinder}>
        {selected ? <Image accessibilityLabel={`Preview of receipt section ${sections.indexOf(selected) + 1}`} source={{ uri: selected.processedUri }} style={StyleSheet.absoluteFill} resizeMode="contain" /> : readyToReview ? <Image accessibilityLabel="Receipt awaiting review" source={{ uri: sections[0]!.processedUri }} style={StyleSheet.absoluteFill} resizeMode="contain" /> : showCamera ? <>
          {NativeScanner ? <NativeScanner key={`${mode}-${replaceId ?? 'new'}`} style={StyleSheet.absoluteFill} active={!busy && !full && (!sections.length || Boolean(replaceId))} mode={mode} torch={torch} command={command}
            onStatus={event => { if (!mounted.current || eventEpoch !== nativeEpoch.current || !nativeVisible.current) return; const status = parseScannerStatus(event.nativeEvent); if (status) {
              setScannerMessage(status.message); setNativeProcessing(status.state === 'processing');
              if (longStarted.current) {
                if (status.acceptedHeight !== undefined) setHasAcceptedReceipt(status.acceptedHeight > 0);
                // Older linked engines report capacity used after accepting pixels.
                // Retain compatibility without displaying that value as completion.
                else if (status.state === 'scanning' && (status.progress ?? 0) > 0) setHasAcceptedReceipt(true);
              }
            } }}
            onCapture={event => acceptNative(event.nativeEvent)}
            onError={event => { if (!mounted.current || eventEpoch !== nativeEpoch.current || !nativeVisible.current) return; nativeEpoch.current++; longStarted.current = false; const data = event.nativeEvent as { message?: unknown } | null; setError(typeof data?.message === 'string' ? data.message.slice(0, 300) : 'Scanning failed. Try again or choose a gallery image.'); setScanning(false); setNativeProcessing(false); setCommand(c => ({ id: c.id + 1, type: 'reset' })); }} /> : <CameraView ref={camera} style={StyleSheet.absoluteFill} facing="back" mode="picture" enableTorch={torch} animateShutter
            onCameraReady={() => setReady(true)} onMountError={() => { setCameraError(true); setReady(false); setError('The camera could not start. Retry it or choose a photo from your gallery.'); }} />
          }
          {!continuous ? <View pointerEvents="none" style={styles.guide}>
            {mode === 'long' && previous && !replaceId ? <View style={{ height: '20%', overflow: 'hidden', opacity: 0.5 }}>
              <Image source={{ uri: previous.processedUri }} style={{ width: '100%', height: '500%', position: 'absolute', bottom: 0 }} resizeMode="stretch" />
            </View> : null}
            <View style={[styles.corner, styles.tl, { borderColor: t.onCamera }]} /><View style={[styles.corner, styles.tr, { borderColor: t.onCamera }]} />
            <View style={[styles.corner, styles.bl, { borderColor: t.onCamera }]} /><View style={[styles.corner, styles.br, { borderColor: t.onCamera }]} />
          </View> : null}
          {!continuous && !ready ? <ActivityIndicator accessibilityLabel="Starting camera" size="large" color={t.onCamera} /> : null}
        </> : <View style={styles.empty} accessibilityLiveRegion="polite" {...(startingCamera ? { accessible: true, accessibilityRole: 'progressbar' as const, accessibilityLabel: 'Starting camera' } : null)}>
          {/* The spinner, the neutral heading and NO call to action while the
              permission status is still being read: this state is reached on
              every open, including the ordinary already-granted one, and
              "Allow camera access" flashing there tells the owner their
              permission is missing when it is not. Same pattern as
              ScannerStatusStates' launching state — its copy is not reused
              verbatim because it describes the ML Kit scanner's automatic
              background removal, which this path does not do. */}
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
      <ScrollView key={`controls-${fontScale}-${textLayoutRevision}`} style={{ flexGrow: 0, maxHeight: '48%' }} contentContainerStyle={styles.bottom}>
        {continuous && scanning && !selected ? <Text accessibilityLiveRegion="polite" style={[styles.body, ink]}>{nativeProcessing ? 'Preparing scan' : hasAcceptedReceipt ? 'Receipt captured so far' : 'Waiting for the top edge'}</Text> : null}
        <Text accessibilityLiveRegion="polite" style={[styles.body, ink]}>{selected ? hint ?? (selected.quality ? 'Quality checked. Make sure every line is readable.' : 'Check the photo before continuing. Nothing is saved as an expense yet.') : readyToReview ? 'Your receipt is kept here. Review it to approve, retake, or remove it.' : continuous ? nativeProcessing ? 'Finishing your receipt. Keep this screen open.' : scannerMessage : replaceId ? `Retake section ${sections.findIndex(s => s.localId === replaceId) + 1}` : mode === 'long' ? `Section ${Math.min(sections.length + 1, MAX_SECTIONS)} of up to ${MAX_SECTIONS} · ${previous ? 'Match the last few lines, then move down.' : 'Start at the top of one long receipt.'}` : 'Keep the whole receipt in frame, including the total.'}</Text>
        {!selected && !readyToReview && showCamera ? <Text style={[styles.small, ink]}>{continuous ? mode === 'long' ? 'Move slowly from top to bottom. Hold steady to finish.' : 'Auto capture is on.' : 'Manual camera · Tap Capture to take a photo.'}</Text> : null}
        {sections.length ? <ScrollView horizontal contentContainerStyle={styles.filmstrip} showsHorizontalScrollIndicator={false}>
          {sections.map((section, i) => <Pressable key={section.localId} accessibilityRole="button" accessibilityLabel={`Review section ${i + 1}${qualityHint(section.quality) ? ', quality warning' : ''}`} accessibilityState={{ selected: selectedId === section.localId, disabled: busy }} disabled={busy} onPress={() => { setSelectedId(section.localId); setReplaceId(null); setError(null); setReady(false); }} style={[styles.thumb, { borderColor: selectedId === section.localId ? t.onCamera : 'transparent' }]}>
            <Image source={{ uri: section.processedUri }} style={{ flex: 1, borderRadius: 6 }} resizeMode="cover" />
            <Text style={[styles.number, ink]}>{i + 1}{qualityHint(section.quality) ? ' !' : ''}</Text>
          </Pressable>)}
        </ScrollView> : null}
        {selected ? <>
          <View style={styles.row}>
            <CameraAction label="Crop" icon="crop-outline" onPress={() => setCropping(true)} disabled={busy} />
            <CameraAction label="Rotate" icon="refresh-outline" onPress={() => void rotate()} disabled={busy} />
            <CameraAction label="Check quality" icon="checkmark-circle-outline" onPress={() => void checkQuality()} disabled={busy} />
          </View>
          <Text style={[styles.small, ink]}>Quality checks and crop correction send this photo securely for processing.</Text>
          <View style={styles.row}>
            <CameraAction label="Retake" icon="camera-outline" onPress={() => { nativeAccepted.current = false; setMode(selected.captureMode ?? 'standard'); setCommand(c => ({ id: c.id + 1, type: 'reset' })); setReplaceId(selected.localId); setSelectedId(null); setReady(false); }} disabled={busy} />
            <CameraAction label="Remove" icon="trash-outline" onPress={() => { nativeAccepted.current = false; setCommand(c => ({ id: c.id + 1, type: 'reset' })); put(removeSessionSection(sections, selected.localId)); setSelectedId(null); setReady(false); }} disabled={busy} />
            {selected.processedUri !== selected.originalUri ? <CameraAction label={selectedCustomScan ? 'Use unenhanced scan' : 'Use original'} onPress={() => updateSection({ ...selected, processedUri: selected.originalUri, width: selected.originalWidth ?? selected.width, height: selected.originalHeight ?? selected.height, quality: null, cropCorners: undefined, processingMode: 'original', transformVersion: selectedCustomScan ? selected.captureMode === 'long' ? 'custom-panorama-v1' : 'custom-frame-v1' : undefined })} disabled={busy} /> : null}
          </View>
          {sections.length > 1 ? <View style={styles.row}>
            <CameraAction label="Move earlier" icon="arrow-back" onPress={() => put(moveSessionSection(sections, selected.localId, -1))} disabled={busy || sections[0]?.localId === selected.localId} />
            <CameraAction label="Move later" icon="arrow-forward" onPress={() => put(moveSessionSection(sections, selected.localId, 1))} disabled={busy || previous?.localId === selected.localId} />
          </View> : null}
          <View style={styles.row}>
            {!continuous && sections.length < MAX_SECTIONS ? <CameraAction label="Add section" icon="add-outline" onPress={() => { setMode('long'); setSelectedId(null); setReady(false); }} disabled={busy} /> : null}
            {/* The lock is released in `finally`, and re-entry is held off by
                `submitting` instead. Held by the ref alone, a parent that did
                not unmount this screen — because `onDone` threw — left every
                later action (crop, rotate, quality, gallery, capture) silently
                returning from `run` with nothing on screen to say why. */}
            <CameraAction primary label={sections.length === 1 ? 'Use this receipt' : `Use ${sections.length} sections`} onPress={() => {
              if (locked.current || submitting) return;
              locked.current = true; setSubmitting(true); setError(null);
              try { onDone(sections); }
              catch (e) { setSubmitting(false); setError(e instanceof Error ? e.message : 'Could not continue with this receipt. Please try again.'); haptics.failed(); }
              finally { locked.current = false; }
            }} disabled={busy || submitting} />
          </View>
        </> : readyToReview ? <CameraAction primary label="Review receipt" icon="checkmark-outline" onPress={() => setSelectedId(sections[0]!.localId)} disabled={busy} /> : <>
          <View style={styles.row}>
            {(['standard', 'long'] as const).map(value => <Pressable key={value} accessibilityRole="tab" accessibilityLabel={value === 'long' ? continuous ? 'Long receipt' : 'Manual sections' : 'Standard receipt'} accessibilityState={{ selected: mode === value, disabled: busy || scanning || nativeProcessing }} disabled={busy || scanning || nativeProcessing} onPress={() => { nativeEpoch.current++; nativeAccepted.current = false; setCommand(c => ({ id: c.id + 1, type: 'reset' })); setScannerMessage(value === 'long' ? 'Position the top of the receipt, then start scanning.' : 'Position the receipt on a contrasting surface.'); setMode(value); haptics.tapped(); }} style={[styles.mode, { minWidth: 48, minHeight: 48, backgroundColor: mode === value ? t.brandFill : t.cameraSurface }]}><Text style={[styles.body, ink]}>{value === 'long' ? continuous ? 'Long receipt' : 'Manual sections' : 'Standard'}</Text></Pressable>)}
          </View>
          <View style={styles.shutterRow}>
            <CameraAction label="Gallery" icon="images-outline" onPress={() => void gallery()} disabled={busy || full || scanning || nativeProcessing || (continuous && sections.length > 0 && !replaceId)} />
            {continuous ? <CameraAction primary label={nativeProcessing ? 'Finishing…' : mode === 'long' ? scanning ? 'Finish scan' : 'Start scanning' : 'Capture now'} icon={scanning ? 'stop-outline' : 'scan-outline'} onPress={nativeAction} disabled={busy || !showCamera || full || nativeProcessing || (scanning && !hasAcceptedReceipt) || Boolean(sections.length && !replaceId)} /> : <Pressable accessibilityRole="button" accessibilityLabel="Capture receipt section" accessibilityState={{ disabled: busy || !ready || !showCamera || full }} disabled={busy || !ready || !showCamera || full} onPress={() => void capture()} style={({ pressed }) => [styles.shutter, { minWidth: 76, minHeight: 76, borderColor: t.onCamera, opacity: busy || !ready || full ? 0.4 : pressed ? 0.65 : 1 }]}>
              {busy ? <ActivityIndicator color={t.onCamera} /> : <View style={[styles.shutterCore, { backgroundColor: t.onCamera }]} />}
            </Pressable>}
            <CameraAction label={sections.length ? `Review (${sections.length})` : 'Review'} icon="checkmark-outline" onPress={() => { setSelectedId(sections[0]?.localId ?? null); setReady(false); }} disabled={busy || !sections.length || scanning || nativeProcessing} />
          </View>
          {full ? <Text style={[styles.small, ink]}>All 8 sections are ready. Review them to finish or remove a section.</Text> : null}
        </>}
        {busy ? <ActivityIndicator accessibilityLabel="Processing receipt photo" color={t.onCamera} /> : null}
      </ScrollView>
    </>}
  </View>;
}
const styles = StyleSheet.create({
  root: { flex: 1 }, header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 8, gap: 8 },
  heading: { fontFamily: font.display, fontSize: typeScale.title, textAlign: 'center', flex: 1 },
  body: { fontFamily: font.sansMedium, fontSize: typeScale.bodySm, textAlign: 'center' },
  small: { fontFamily: font.sans, fontSize: typeScale.caption, textAlign: 'center' },
  notice: { fontFamily: font.sans, fontSize: typeScale.bodySm, paddingHorizontal: 16, paddingVertical: 8 },
  viewfinder: { flex: 1, minHeight: 120, overflow: 'hidden', justifyContent: 'center' },
  empty: { alignItems: 'center', padding: 24, gap: 16 }, bottom: { padding: 12, gap: 8 },
  guide: { position: 'absolute', left: '6%', right: '6%', top: '5%', bottom: '5%' },
  corner: { position: 'absolute', width: 30, height: 30 }, tl: { top: 0, left: 0, borderTopWidth: 3, borderLeftWidth: 3 }, tr: { top: 0, right: 0, borderTopWidth: 3, borderRightWidth: 3 }, bl: { bottom: 0, left: 0, borderBottomWidth: 3, borderLeftWidth: 3 }, br: { bottom: 0, right: 0, borderBottomWidth: 3, borderRightWidth: 3 },
  row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'center', gap: 8 },
  shutterRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'center', gap: 8 },
  shutter: { width: 76, height: 76, borderRadius: 38, borderWidth: 3, alignItems: 'center', justifyContent: 'center' }, shutterCore: { width: 62, height: 62, borderRadius: 31 },
  mode: { minHeight: 48, borderRadius: 12, justifyContent: 'center', paddingHorizontal: 18, paddingVertical: 8 },
  filmstrip: { gap: 8, paddingVertical: 4 }, thumb: { width: 56, height: 76, borderWidth: 2, borderRadius: 8, overflow: 'hidden' }, number: { position: 'absolute', bottom: 0, left: 0, right: 0, textAlign: 'center', backgroundColor: 'rgba(0,0,0,0.7)', fontFamily: font.sansSemibold, fontSize: typeScale.caption },
});
