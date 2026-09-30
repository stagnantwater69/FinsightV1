import { Platform } from 'react-native';
import type { ReceiptProcessingMode } from './receiptCapture';

export const RECEIPT_FILTER_MODES = ['original', 'enhanced', 'grayscale', 'black-white'] as const;
export type ReceiptFilterMode = typeof RECEIPT_FILTER_MODES[number];

export interface ReceiptFilterResult {
  uri: string;
  width: number;
  height: number;
  processingMode: Extract<ReceiptProcessingMode, 'original' | 'clear-colour' | 'grayscale' | 'black-white'>;
  transformVersion: 'android-local-filter-v1';
}

interface ReceiptFilterModule {
  applyReceiptFilter?: (sourceUri: string, mode: ReceiptFilterMode) => Promise<unknown>;
}

const processingModeFor = {
  original: 'original',
  enhanced: 'clear-colour',
  grayscale: 'grayscale',
  'black-white': 'black-white',
} as const satisfies Record<ReceiptFilterMode, ReceiptFilterResult['processingMode']>;

let nativeModulePromise: Promise<ReceiptFilterModule | null> | undefined;

async function getReceiptFilterModule(): Promise<ReceiptFilterModule | null> {
  if (Platform.OS !== 'android') return null;
  nativeModulePromise ??= import('expo-modules-core')
    .then(({ requireOptionalNativeModule }) => {
      try {
        return requireOptionalNativeModule<ReceiptFilterModule>('FinsightReceiptScanner');
      } catch {
        return null;
      }
    })
    .catch(() => null);
  return nativeModulePromise;
}

const localUri = (value: unknown): value is string => typeof value === 'string'
  && value.length >= 1
  && value.length <= 4096
  && /^file:\/\/\/.+/.test(value)
  && !/[\r\n\0]/.test(value);

const dimension = (value: unknown): value is number => typeof value === 'number'
  && Number.isInteger(value)
  && value >= 1
  && value <= 40_000;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function parseReceiptFilterResult(value: unknown, mode: ReceiptFilterMode): ReceiptFilterResult {
  const data = record(value);
  if (!data
    || !localUri(data.uri)
    || !dimension(data.width)
    || !dimension(data.height)
    || data.width * data.height > 40_000_000
    || data.processingMode !== processingModeFor[mode]
    || data.transformVersion !== 'android-local-filter-v1') {
    throw new Error('The scanner returned an invalid filtered receipt. The current image was kept.');
  }
  return {
    uri: data.uri,
    width: data.width,
    height: data.height,
    processingMode: processingModeFor[mode],
    transformVersion: 'android-local-filter-v1',
  };
}

export async function applyReceiptFilter(sourceUri: string, mode: ReceiptFilterMode): Promise<ReceiptFilterResult> {
  if (Platform.OS !== 'android') {
    throw new Error('Local receipt filters are available only in the Android scanner.');
  }
  if (!localUri(sourceUri)) {
    throw new Error('Only a local receipt image can be filtered. The current image was kept.');
  }
  const module = await getReceiptFilterModule();
  if (!module?.applyReceiptFilter) {
    throw new Error('This installed Android build does not include local receipt filters.');
  }
  const value = await module.applyReceiptFilter(sourceUri, mode);
  return parseReceiptFilterResult(value, mode);
}
