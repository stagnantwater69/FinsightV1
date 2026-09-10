import type { ComponentType } from 'react';
import { Platform, type ViewProps } from 'react-native';
import { requireNativeViewManager, requireOptionalNativeModule } from 'expo-modules-core';
import { createReceiptSection } from './receiptCameraSession';
import type { ReceiptSection } from './receiptCapture';

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
/** Old builds and Expo Go retain a clearly identified manual fallback. */
export function getCustomScannerView(): ComponentType<CustomScannerViewProps> | null {
  if (nativeView !== undefined) return nativeView;
  nativeView = null;
  try {
    if (Platform.OS === 'android' && requireOptionalNativeModule('FinsightReceiptScanner')) {
      nativeView = requireNativeViewManager<CustomScannerViewProps>('FinsightReceiptScanner');
    }
  } catch { /* The native engine is not linked in this installed build. */ }
  return nativeView;
}
const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const dimension = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 40000;
const localUri = (value: unknown): value is string => typeof value === 'string' && value.length <= 4096 && /^file:\/\/\/.+/.test(value) && !/[\r\n\0]/.test(value);
export function parseScannerStatus(value: unknown): ScannerStatus | null {
  const data = record(value);
  if (!data || typeof data.state !== 'string' || typeof data.message !== 'string') return null;
  return { state: data.state.slice(0, 60), message: data.message.slice(0, 300), ...(typeof data.progress === 'number' && Number.isFinite(data.progress) ? { progress: Math.max(0, Math.min(1, data.progress)) } : {}),
    ...(typeof data.acceptedHeight === 'number' && Number.isInteger(data.acceptedHeight) && data.acceptedHeight >= 0 && data.acceptedHeight <= 16000 ? { acceptedHeight: data.acceptedHeight } : {}) };
}
/** Never accept remote URI payloads or unbounded dimensions from a bridge event. */
export function receiptSectionFromNative(value: unknown): ReceiptSection {
  const data = record(value);
  if (!data || !localUri(data.originalUri) || !localUri(data.processedUri) || !dimension(data.width) || !dimension(data.height) || !dimension(data.originalWidth) || !dimension(data.originalHeight) || data.width * data.height > 40000000 || data.originalWidth * data.originalHeight > 40000000 || (data.mode !== 'standard' && data.mode !== 'long') || data.transformVersion !== (data.mode === 'long' ? 'custom-panorama-v1' : 'custom-frame-v1')) {
    throw new Error('The scanner returned an incomplete image. Please scan the receipt again.');
  }
  return { ...createReceiptSection({ uri: data.originalUri, width: data.originalWidth, height: data.originalHeight }, 'native-document-scanner'), processedUri: data.processedUri, width: data.width, height: data.height, processingMode: 'native-selected', captureMode: data.mode, transformVersion: data.mode === 'long' ? 'custom-panorama-v1' : 'custom-frame-v1' };
}
