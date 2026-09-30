import type { ComponentType } from 'react';
import { Platform, type ViewProps } from 'react-native';
import { requireNativeViewManager, requireOptionalNativeModule } from 'expo-modules-core';
import { createReceiptSection } from './receiptCameraSession';
import { cropQuadProblem } from './cropQuad';
import type { Corners, ReceiptCropOutcome, ReceiptProcessingMode, ReceiptSection } from './receiptCapture';

export type ScannerMode = 'standard' | 'long' | 'manual';
export interface ScannerCommand { id: number; type: 'capture' | 'start' | 'finish' | 'undo' | 'reset'; }
export interface ScannerStatus { state: string; message: string; progress?: number; acceptedHeight?: number; acceptedSections?: number; maxZoomRatio?: number; }
export interface CustomScannerViewProps extends ViewProps {
  active: boolean; mode: ScannerMode; torch: boolean; zoomRatio: number; autoCapture: boolean; command: ScannerCommand;
  onStatus: (event: { nativeEvent: unknown }) => void;
  onCapture: (event: { nativeEvent: unknown }) => void;
  onError: (event: { nativeEvent: unknown }) => void;
}
let nativeView: ComponentType<CustomScannerViewProps> | null | undefined;
interface CustomScannerModule {
  captureContract?: number;
  deleteCachedFiles?: (uris: string[]) => Promise<number>;
  clearReceiptCache?: () => Promise<number>;
}
let nativeModule: CustomScannerModule | null | undefined;

function getCustomScannerModule(): CustomScannerModule | null {
  if (nativeModule !== undefined) return nativeModule;
  nativeModule = null;
  try {
    if (Platform.OS === 'android') {
      nativeModule = requireOptionalNativeModule<CustomScannerModule>('FinsightReceiptScanner');
    }
  } catch { /* The native engine is not linked in this installed build. */ }
  return nativeModule;
}

/**
 * The native engine behaviour this JavaScript needs: an explicit shutter that
 * always takes the photo, with cropping after capture. An installed binary
 * older than this still waits for all four receipt edges before honouring the
 * shutter, so it is not driven at all; the manual camera is used instead.
 */
export const NATIVE_CAPTURE_CONTRACT = 3;

/** A native engine is linked but predates the capture contract (a stale install). */
export function isCustomScannerOutdated(): boolean {
  const module = getCustomScannerModule();
  return module !== null && !(typeof module.captureContract === 'number' && module.captureContract >= NATIVE_CAPTURE_CONTRACT);
}

/** Old builds and Expo Go retain a clearly identified manual fallback. */
export function getCustomScannerView(): ComponentType<CustomScannerViewProps> | null {
  if (nativeView !== undefined) return nativeView;
  nativeView = null;
  try {
    if (getCustomScannerModule() && !isCustomScannerOutdated()) {
      nativeView = requireNativeViewManager<CustomScannerViewProps>('FinsightReceiptScanner');
    }
  } catch { /* The native engine is not linked in this installed build. */ }
  return nativeView;
}

/** Best-effort removal restricted by native code to FinSight's scanner cache. */
export async function deleteCustomScannerFiles(uris: readonly (string | undefined)[]): Promise<number> {
  const module = getCustomScannerModule();
  const files = [...new Set(uris.filter((uri): uri is string => typeof uri === 'string' && uri.length > 0))].slice(0, 128);
  if (!module?.deleteCachedFiles || files.length === 0) return 0;
  let deleted = 0;
  for (let index = 0; index < files.length; index += 32) {
    try { deleted += await module.deleteCachedFiles(files.slice(index, index + 32)); } catch { /* Continue with the remaining bounded chunks. */ }
  }
  return deleted;
}

/** Clears only UUID-named files created by the native receipt scanner. */
export async function clearCustomScannerCache(): Promise<number> {
  const module = getCustomScannerModule();
  if (!module?.clearReceiptCache) return 0;
  try { return await module.clearReceiptCache(); } catch { return 0; }
}
const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const dimension = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 40000;
const localUri = (value: unknown): value is string => typeof value === 'string' && value.length <= 4096 && /^file:\/\/\/.+/.test(value) && !/[\r\n\0]/.test(value);
function nativeCorners(value: unknown, width: number, height: number): Corners | undefined {
  const data = record(value);
  const read = (key: keyof Corners) => {
    const point = record(data?.[key]);
    return point && typeof point.x === 'number' && Number.isFinite(point.x) && typeof point.y === 'number' && Number.isFinite(point.y)
      && point.x >= 0 && point.x <= width && point.y >= 0 && point.y <= height
      ? { x: point.x, y: point.y }
      : null;
  };
  const topLeft = read('topLeft');
  const topRight = read('topRight');
  const bottomRight = read('bottomRight');
  const bottomLeft = read('bottomLeft');
  return topLeft && topRight && bottomRight && bottomLeft
    ? { topLeft, topRight, bottomRight, bottomLeft }
    : undefined;
}
export function parseScannerStatus(value: unknown): ScannerStatus | null {
  const data = record(value);
  if (!data || typeof data.state !== 'string' || typeof data.message !== 'string') return null;
  return { state: data.state.slice(0, 60), message: data.message.slice(0, 300), ...(typeof data.progress === 'number' && Number.isFinite(data.progress) ? { progress: Math.max(0, Math.min(1, data.progress)) } : {}),
    ...(typeof data.acceptedHeight === 'number' && Number.isInteger(data.acceptedHeight) && data.acceptedHeight >= 0 && data.acceptedHeight <= 16000 ? { acceptedHeight: data.acceptedHeight } : {}),
    ...(typeof data.acceptedSections === 'number' && Number.isInteger(data.acceptedSections) && data.acceptedSections >= 0 && data.acceptedSections <= 8 ? { acceptedSections: data.acceptedSections } : {}),
    ...(typeof data.maxZoomRatio === 'number' && Number.isFinite(data.maxZoomRatio) && data.maxZoomRatio >= 1 && data.maxZoomRatio <= 100 ? { maxZoomRatio: data.maxZoomRatio } : {}) };
}
/** Never accept remote URI payloads or unbounded dimensions from a bridge event. */
export function receiptSectionFromNative(value: unknown): ReceiptSection {
  const data = record(value);
  if (!data || !localUri(data.originalUri) || !localUri(data.processedUri) || !dimension(data.width) || !dimension(data.height) || !dimension(data.originalWidth) || !dimension(data.originalHeight) || data.width * data.height > 40000000 || data.originalWidth * data.originalHeight > 40000000 || (data.mode !== 'standard' && data.mode !== 'long')) {
    throw new Error('The scanner returned an incomplete image. Please scan the receipt again.');
  }
  if (data.filterSourceUri !== undefined && !localUri(data.filterSourceUri)) {
    throw new Error('The scanner returned an incomplete image. Please scan the receipt again.');
  }
  if (typeof data.transformVersion !== 'string') {
    throw new Error('The scanner returned an incomplete image. Please scan the receipt again.');
  }
  const transformVersion = data.transformVersion;
  const legacyStandard = data.mode === 'standard' && transformVersion === 'custom-frame-v1';
  const fullResolutionStill = (data.mode === 'standard' || data.mode === 'long') && transformVersion === 'custom-still-v2';
  const fullResolutionStillV3 = (data.mode === 'standard' || data.mode === 'long') && transformVersion === 'custom-still-v3';
  const long = data.mode === 'long' && transformVersion === 'custom-panorama-v1';
  const corners = nativeCorners(data.corners, data.originalWidth, data.originalHeight);
  let cropOutcome: ReceiptCropOutcome | undefined;
  let processingMode: ReceiptProcessingMode;
  if (fullResolutionStillV3) {
    const nativeCropOutcome = data.cropOutcome;
    if (nativeCropOutcome !== 'perspective'
      && nativeCropOutcome !== 'visible-section'
      && nativeCropOutcome !== 'original-fallback') {
      throw new Error('The scanner returned an incomplete image. Please scan the receipt again.');
    }
    const nativeProcessingMode = data.processingMode;
    if (!localUri(data.filterSourceUri)
      || (nativeProcessingMode !== 'clear-colour' && nativeProcessingMode !== 'original')) {
      throw new Error('The scanner returned an incomplete image. Please scan the receipt again.');
    }
    const cropped = nativeCropOutcome === 'perspective' || nativeCropOutcome === 'visible-section';
    if ((cropped && (!corners || cropQuadProblem(corners, data.originalWidth, data.originalHeight) !== null))
      || (nativeCropOutcome === 'original-fallback' && data.corners !== undefined)) {
      throw new Error('The scanner returned an incomplete image. Please scan the receipt again.');
    }
    cropOutcome = nativeCropOutcome;
    processingMode = nativeProcessingMode;
  } else {
    if ((!legacyStandard && !fullResolutionStill && !long)
      || (fullResolutionStill && (!corners || data.processingMode !== 'clear-colour'))) {
      throw new Error('The scanner returned an incomplete image. Please scan the receipt again.');
    }
    processingMode = data.processingMode === 'clear-colour' ? 'clear-colour' : 'native-selected';
  }
  return {
    ...createReceiptSection({ uri: data.originalUri, width: data.originalWidth, height: data.originalHeight }, 'native-document-scanner'),
    processedUri: data.processedUri,
    ...(data.filterSourceUri ? { filterSourceUri: data.filterSourceUri } : {}),
    width: data.width,
    height: data.height,
    processingMode,
    captureMode: data.mode,
    transformVersion,
    ...(cropOutcome ? { cropOutcome } : {}),
    cropCorners: corners,
  };
}
