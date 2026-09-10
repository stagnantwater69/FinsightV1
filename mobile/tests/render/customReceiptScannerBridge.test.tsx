import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('expo-modules-core', () => ({ requireNativeViewManager: vi.fn(), requireOptionalNativeModule: vi.fn(() => null) }));
const { receiptSectionFromNative, parseScannerStatus } = await import('../../src/lib/customReceiptScanner');

const payload = (mode = 'standard') => ({
  originalUri: 'file:///cache/original.jpg', processedUri: 'file:///cache/processed.jpg',
  originalWidth: 1200, originalHeight: 2400, width: 1000, height: 2000,
  mode, transformVersion: mode === 'long' ? 'custom-panorama-v1' : 'custom-frame-v1',
});

describe('custom scanner bridge boundary (native processing not simulated)', () => {
  beforeEach(() => vi.clearAllMocks());
  it.each(['standard', 'long'])('preserves original evidence and one processed %s image', mode => {
    const section = receiptSectionFromNative(payload(mode));
    expect(section).toMatchObject({ originalUri: 'file:///cache/original.jpg', processedUri: 'file:///cache/processed.jpg',
      originalWidth: 1200, originalHeight: 2400, width: 1000, height: 2000,
      captureMode: mode, processingMode: 'native-selected', captureSource: 'native-document-scanner' });
    expect(section.localId).toBeTruthy();
  });
  it.each([null, undefined, [], 'image', {}, { ...payload(), mode: 'pages' },
    { ...payload(), transformVersion: 'custom-panorama-v1' }])('rejects incomplete or inconsistent event %#', value => {
    expect(() => receiptSectionFromNative(value)).toThrow(/scan the receipt again/i);
  });
  it.each(['https://example.com/receipt.jpg', 'content://receipt', 'data:image/jpeg;base64,x', '', 'file:///',
    'file:///receipt\n.jpg', 'file:///receipt\0.jpg', `file:///${'x'.repeat(4096)}`])('rejects unsafe original URI %#', uri => {
    expect(() => receiptSectionFromNative({ ...payload(), originalUri: uri })).toThrow();
    expect(() => receiptSectionFromNative({ ...payload(), processedUri: uri })).toThrow();
  });
  it.each([0, -1, NaN, Infinity, 0.5, '1200', 40001])('rejects invalid dimensions %#', dimension => {
    for (const key of ['width', 'height', 'originalWidth', 'originalHeight']) {
      expect(() => receiptSectionFromNative({ ...payload(), [key]: dimension })).toThrow();
    }
  });
  it('rejects a decompression-sized image even when individual edges are bounded', () => {
    expect(() => receiptSectionFromNative({ ...payload(), width: 40000, height: 40000 })).toThrow();
    expect(() => receiptSectionFromNative({ ...payload(), originalWidth: 40000, originalHeight: 40000 })).toThrow();
  });
  it('bounds progress and copy without accepting non-finite progress', () => {
    expect(parseScannerStatus({ state: 'ready', message: 'Steady', progress: 2 })).toEqual({ state: 'ready', message: 'Steady', progress: 1 });
    expect(parseScannerStatus({ state: 'ready', message: 'Steady', progress: -1 })?.progress).toBe(0);
    expect(parseScannerStatus({ state: 'ready', message: 'Steady', progress: NaN })?.progress).toBeUndefined();
    expect(parseScannerStatus({ state: 'x'.repeat(100), message: 'x'.repeat(500) })?.message).toHaveLength(300);
    expect(parseScannerStatus({ state: 'x'.repeat(100), message: 'x'.repeat(500) })?.state).toHaveLength(60);
    expect(parseScannerStatus(null)).toBeNull();
    expect(parseScannerStatus({ state: 'ready', message: 42 })).toBeNull();
  });
  it.each([0, 1, 1800, 16000])('accepts bounded integer captured height %s', acceptedHeight => {
    expect(parseScannerStatus({ state: 'scanning', message: 'Move slowly', acceptedHeight })?.acceptedHeight).toBe(acceptedHeight);
  });
  it.each([-1, 16001, 1.5, NaN, Infinity, -Infinity, '1800', null, {}, []])('ignores invalid captured height %#', acceptedHeight => {
    expect(parseScannerStatus({ state: 'scanning', message: 'Move slowly', acceptedHeight })?.acceptedHeight).toBeUndefined();
  });
});
