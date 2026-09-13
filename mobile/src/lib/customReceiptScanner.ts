import type { ComponentType } from 'react';
import { Platform, type ViewProps } from 'react-native';
import { requireNativeViewManager, requireOptionalNativeModule } from 'expo-modules-core';
import { createReceiptSection } from './receiptCameraSession';
import type { Corners, ReceiptProcessingMode, ReceiptSection } from './receiptCapture';

export type ScannerMode = 'standard' | 'long';
export interface ScannerCommand { id: number; type: 'capture' | 'start' | 'finish' | 'reset'; }
export interface ScannerStatus { state: string; message: string; progress?: number; acceptedHeight?: number; }
export interface CustomScannerViewProps extends ViewProps {
  active: boolean; mode: ScannerMode; torch: boolean; command: ScannerCommand;
  onStatus: (event: { nativeEvent: unknown }) => void;
  onCapture: (event: { nativeEvent: unknown }) => void;
  onError: (event: { nativeEvent: unknown }) => void;
}
let nativeView: ComponentType<CustomScannerViewProps> | null | undefined;
interface CustomScannerModule {
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

/** Old builds and Expo Go retain a clearly identified manual fallback. */
export function getCustomScannerView(): ComponentType<CustomScannerViewProps> | null {
  if (nativeView !== undefined) return nativeView;
  nativeView = null;
  try {
    if (getCustomScannerModule()) {
      nativeView = requireNativeViewManager<CustomScannerViewProps>('FinsightReceiptScanner');
    }
  } catch { /* The native engine is not linked in this installed build. */ }
  return nativeView;
}

/** Best-effort removal restricted by native code to FinSight's scanner cache. */
export async function deleteCustomScannerFiles(uris: readonly (string | undefined)[]): Promise<number> {
  const module = getCustomScannerModule();
  const files = [...new Set(uris.filter((uri): uri is string => typeof uri === 'string' && uri.length > 0))].slice(0, 32);
  if (!module?.deleteCachedFiles || files.length === 0) return 0;
  try { return await module.deleteCachedFiles(files); } catch { return 0; }
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
    ...(typeof data.acceptedHeight === 'number' && Number.isInteger(data.acceptedHeight) && data.acceptedHeight >= 0 && data.acceptedHeight <= 16000 ? { acceptedHeight: data.acceptedHeight } : {}) };
}
/** Never accept remote URI payloads or unbounded dimensions from a bridge event. */
export function receiptSectionFromNative(value: unknown): ReceiptSection {
  const data = record(value);
  if (!data || !localUri(data.originalUri) || !localUri(data.processedUri) || !dimension(data.width) || !dimension(data.height) || !dimension(data.originalWidth) || !dimension(data.originalHeight) || data.width * data.height > 40000000 || data.originalWidth * data.originalHeight > 40000000 || (data.mode !== 'standard' && data.mode !== 'long')) {
    throw new Error('The scanner returned an incomplete image. Please scan the receipt again.');
  }
  if (typeof data.transformVersion !== 'string') {
    throw new Error('The scanner returned an incomplete image. Please scan the receipt again.');
  }
  const transformVersion = data.transformVersion;
  const legacyStandard = data.mode === 'standard' && transformVersion === 'custom-frame-v1';
  const fullResolutionStandard = data.mode === 'standard' && transformVersion === 'custom-still-v2';
  const long = data.mode === 'long' && transformVersion === 'custom-panorama-v1';
  const corners = nativeCorners(data.corners, data.originalWidth, data.originalHeight);
  if ((!legacyStandard && !fullResolutionStandard && !long)
    || (fullResolutionStandard && (!corners || data.processingMode !== 'clear-colour'))) {
    throw new Error('The scanner returned an incomplete image. Please scan the receipt again.');
  }
  const processingMode: ReceiptProcessingMode = data.processingMode === 'clear-colour' ? 'clear-colour' : 'native-selected';
  return {
    ...createReceiptSection({ uri: data.originalUri, width: data.originalWidth, height: data.originalHeight }, 'native-document-scanner'),
    processedUri: data.processedUri,
    width: data.width,
    height: data.height,
    processingMode,
    captureMode: data.mode,
    transformVersion,
    cropCorners: corners,
  };
}
