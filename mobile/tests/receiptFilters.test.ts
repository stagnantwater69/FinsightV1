import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));
vi.mock('expo-modules-core', () => ({ requireOptionalNativeModule: vi.fn(() => null) }));

const { parseReceiptFilterResult } = await import('../src/lib/receiptFilters');

const validResult = (processingMode: string) => ({
  uri: 'file:///data/user/0/com.finsight/cache/receipt-filter.jpg',
  width: 1200,
  height: 2400,
  processingMode,
  transformVersion: 'android-local-filter-v1',
});

describe('receipt filter bridge result validation', () => {
  it.each([
    ['original', 'original'],
    ['enhanced', 'clear-colour'],
    ['grayscale', 'grayscale'],
    ['black-white', 'black-white'],
  ] as const)('accepts a valid %s result with its exact processing mode', (filter, processingMode) => {
    expect(parseReceiptFilterResult(validResult(processingMode), filter)).toEqual({
      ...validResult(processingMode),
      processingMode,
    });
  });

  it.each([
    null,
    [],
    {},
    { ...validResult('grayscale'), uri: '' },
    { ...validResult('grayscale'), uri: 'https://example.com/receipt.jpg' },
    { ...validResult('grayscale'), uri: 'content://receipt.jpg' },
    { ...validResult('grayscale'), uri: 'file:///receipt.jpg\nignored' },
  ])('rejects malformed or non-local output without exposing it to review', (value) => {
    expect(() => parseReceiptFilterResult(value, 'grayscale')).toThrow(
      'The scanner returned an invalid filtered receipt. The current image was kept.',
    );
  });

  it.each([
    { width: 0, height: 2400 },
    { width: -1, height: 2400 },
    { width: 1.5, height: 2400 },
    { width: Number.NaN, height: 2400 },
    { width: 40_001, height: 1 },
    { width: 1200, height: 0 },
    { width: 8000, height: 5001 },
  ])('rejects invalid dimensions and decompression-sized output: %o', (dimensions) => {
    expect(() => parseReceiptFilterResult({
      ...validResult('clear-colour'),
      ...dimensions,
    }, 'enhanced')).toThrow(/invalid filtered receipt/i);
  });

  it('rejects a processing mode that does not match the requested filter', () => {
    expect(() => parseReceiptFilterResult(validResult('black-white'), 'grayscale')).toThrow(
      /invalid filtered receipt/i,
    );
  });

  it('rejects an unknown transform version', () => {
    expect(() => parseReceiptFilterResult({
      ...validResult('grayscale'),
      transformVersion: 'android-local-filter-v2',
    }, 'grayscale')).toThrow(/invalid filtered receipt/i);
  });
});
