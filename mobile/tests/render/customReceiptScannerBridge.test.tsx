import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('expo-modules-core', () => ({ requireNativeViewManager: vi.fn(), requireOptionalNativeModule: vi.fn(() => null) }));
const { receiptSectionFromNative, parseScannerStatus } = await import('../../src/lib/customReceiptScanner');

const payload = (mode = 'standard') => ({
  originalUri: 'file:///cache/original.jpg', processedUri: 'file:///cache/processed.jpg',
  filterSourceUri: 'file:///cache/rectified.jpg',
  originalWidth: 1200, originalHeight: 2400, width: 1000, height: 2000,
  mode, processingMode: 'clear-colour', transformVersion: mode === 'long' ? 'custom-panorama-v1' : 'custom-still-v2',
  ...(mode === 'standard' ? { corners: {
    topLeft: { x: 100, y: 100 }, topRight: { x: 1100, y: 100 },
    bottomRight: { x: 1100, y: 2300 }, bottomLeft: { x: 100, y: 2300 },
  } } : {}),
});
const manualPayload = () => ({
  ...payload('long'),
  transformVersion: 'custom-still-v2',
  corners: {
    topLeft: { x: 100, y: 100 }, topRight: { x: 1100, y: 100 },
    bottomRight: { x: 1100, y: 2300 }, bottomLeft: { x: 100, y: 2300 },
  },
});
const stillV3Payload = (cropOutcome: 'perspective' | 'visible-section' | 'original-fallback' = 'perspective') => ({
  ...payload('long'),
  mode: 'standard',
  transformVersion: 'custom-still-v3',
  cropOutcome,
  processingMode: 'clear-colour',
  ...(cropOutcome === 'original-fallback' ? {} : { corners: manualPayload().corners }),
});

describe('custom scanner bridge boundary (native processing not simulated)', () => {
  beforeEach(() => vi.clearAllMocks());
  it.each(['standard', 'long'])('preserves original evidence and one processed %s image', mode => {
    const section = receiptSectionFromNative(payload(mode));
    expect(section).toMatchObject({ originalUri: 'file:///cache/original.jpg', processedUri: 'file:///cache/processed.jpg',
      filterSourceUri: 'file:///cache/rectified.jpg',
      originalWidth: 1200, originalHeight: 2400, width: 1000, height: 2000,
      captureMode: mode, processingMode: 'clear-colour', captureSource: 'native-document-scanner' });
    expect(section.localId).toBeTruthy();
  });
  it('keeps compatibility with installed scanners that predate the rectified filter source', () => {
    const legacy = payload();
    delete (legacy as { filterSourceUri?: string }).filterSourceUri;
    expect(receiptSectionFromNative(legacy).filterSourceUri).toBeUndefined();
  });
  it('accepts an installed legacy standard scanner while distinguishing its transform', () => {
    const section = receiptSectionFromNative({ ...payload(), transformVersion: 'custom-frame-v1', corners: undefined, processingMode: undefined });
    expect(section).toMatchObject({ transformVersion: 'custom-frame-v1', processingMode: 'native-selected' });
  });
  it('requires mapped source corners from the full-resolution standard scanner', () => {
    expect(() => receiptSectionFromNative({ ...payload(), corners: undefined })).toThrow(/scan the receipt again/i);
  });
  it('requires the truthful enhanced-color label from the full-resolution standard scanner', () => {
    expect(() => receiptSectionFromNative({ ...payload(), processingMode: undefined })).toThrow(/scan the receipt again/i);
    expect(() => receiptSectionFromNative({ ...payload(), processingMode: 'native-selected' })).toThrow(/scan the receipt again/i);
  });
  it('accepts an enhanced full-resolution still for an ordered manual page', () => {
    expect(receiptSectionFromNative(manualPayload())).toMatchObject({
      captureMode: 'long', transformVersion: 'custom-still-v2', processingMode: 'clear-colour',
      cropCorners: manualPayload().corners,
    });
  });
  it('rejects a manual page without mapped corners or the enhanced-color label', () => {
    expect(() => receiptSectionFromNative({ ...manualPayload(), corners: undefined })).toThrow(/scan the receipt again/i);
    expect(() => receiptSectionFromNative({ ...manualPayload(), processingMode: undefined })).toThrow(/scan the receipt again/i);
    expect(() => receiptSectionFromNative({ ...manualPayload(), processingMode: 'native-selected' })).toThrow(/scan the receipt again/i);
  });
  it.each(['perspective', 'visible-section'] as const)('accepts a v3 %s crop with mapped source corners', cropOutcome => {
    expect(receiptSectionFromNative(stillV3Payload(cropOutcome))).toMatchObject({
      transformVersion: 'custom-still-v3', cropOutcome, processingMode: 'clear-colour',
      filterSourceUri: 'file:///cache/rectified.jpg', cropCorners: manualPayload().corners,
    });
  });
  it('accepts a v3 original fallback only without corners', () => {
    const section = receiptSectionFromNative(stillV3Payload('original-fallback'));
    expect(section).toMatchObject({
      transformVersion: 'custom-still-v3', cropOutcome: 'original-fallback', processingMode: 'clear-colour',
      filterSourceUri: 'file:///cache/rectified.jpg',
    });
    expect(section.cropCorners).toBeUndefined();
  });
  it.each(['clear-colour', 'original'] as const)('accepts the bounded v3 processing mode %s', processingMode => {
    expect(receiptSectionFromNative({ ...stillV3Payload(), processingMode }).processingMode).toBe(processingMode);
  });
  it.each([undefined, null, '', 'cropped', 'original'])('rejects an unknown v3 crop outcome %#', cropOutcome => {
    expect(() => receiptSectionFromNative({ ...stillV3Payload(), cropOutcome })).toThrow(/scan the receipt again/i);
  });
  it.each([undefined, null, {}, {
    topLeft: { x: -1, y: 100 }, topRight: { x: 1100, y: 100 },
    bottomRight: { x: 1100, y: 2300 }, bottomLeft: { x: 100, y: 2300 },
  }])('rejects v3 cropped outcomes without valid mapped corners %#', corners => {
    for (const cropOutcome of ['perspective', 'visible-section'] as const) {
      expect(() => receiptSectionFromNative({ ...stillV3Payload(cropOutcome), corners })).toThrow(/scan the receipt again/i);
    }
  });
  it.each([
    ['coincident', {
      topLeft: { x: 100, y: 100 }, topRight: { x: 100, y: 100 },
      bottomRight: { x: 100, y: 100 }, bottomLeft: { x: 100, y: 100 },
    }],
    ['self-crossing', {
      topLeft: { x: 100, y: 100 }, topRight: { x: 1100, y: 2300 },
      bottomRight: { x: 1100, y: 100 }, bottomLeft: { x: 100, y: 2300 },
    }],
    ['zero-area', {
      topLeft: { x: 100, y: 100 }, topRight: { x: 400, y: 100 },
      bottomRight: { x: 700, y: 100 }, bottomLeft: { x: 1000, y: 100 },
    }],
  ] as const)('rejects %s v3 crop corners even when every point is in bounds', (_case, corners) => {
    for (const cropOutcome of ['perspective', 'visible-section'] as const) {
      expect(() => receiptSectionFromNative({ ...stillV3Payload(cropOutcome), corners })).toThrow(/scan the receipt again/i);
    }
  });
  it.each([null, {}, manualPayload().corners])('rejects any corners on a v3 original fallback %#', corners => {
    expect(() => receiptSectionFromNative({ ...stillV3Payload('original-fallback'), corners })).toThrow(/scan the receipt again/i);
  });
  it.each([undefined, null, '', 'native-selected', 'manual-crop', 'grayscale', 'black-white'])('rejects unsupported v3 processing mode %#', processingMode => {
    expect(() => receiptSectionFromNative({ ...stillV3Payload(), processingMode })).toThrow(/scan the receipt again/i);
  });
  it('requires a bounded local filter source for v3 stills', () => {
    expect(() => receiptSectionFromNative({ ...stillV3Payload(), filterSourceUri: undefined })).toThrow(/scan the receipt again/i);
    expect(() => receiptSectionFromNative({ ...stillV3Payload(), filterSourceUri: 'content://receipt' })).toThrow(/scan the receipt again/i);
  });
  it.each([null, undefined, [], 'image', {}, { ...payload(), mode: 'pages' },
    { ...payload(), transformVersion: 'custom-panorama-v1' }])('rejects incomplete or inconsistent event %#', value => {
    expect(() => receiptSectionFromNative(value)).toThrow(/scan the receipt again/i);
  });
  it.each(['https://example.com/receipt.jpg', 'content://receipt', 'data:image/jpeg;base64,x', '', 'file:///',
    'file:///receipt\n.jpg', 'file:///receipt\0.jpg', `file:///${'x'.repeat(4096)}`])('rejects unsafe original URI %#', uri => {
    expect(() => receiptSectionFromNative({ ...payload(), originalUri: uri })).toThrow();
    expect(() => receiptSectionFromNative({ ...payload(), processedUri: uri })).toThrow();
    expect(() => receiptSectionFromNative({ ...payload(), filterSourceUri: uri })).toThrow();
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
