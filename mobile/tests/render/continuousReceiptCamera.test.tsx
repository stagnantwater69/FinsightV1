import React from 'react';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render } from '@testing-library/react-native';
import { Alert, AppState, Dimensions, Platform, type AppStateStatus } from 'react-native';

const mocks = vi.hoisted(() => ({
  nativeProps: null as any,
  permission: { granted: true, canAskAgain: true },
  request: vi.fn(async () => undefined),
  get: vi.fn(async () => undefined),
  upload: vi.fn(),
  gallery: vi.fn(async () => ({ canceled: true })),
  cleanup: vi.fn(async () => 0),
  applyReceiptFilter: vi.fn(),
  manipulate: vi.fn(),
}));

vi.mock('expo-modules-core', () => ({
  requireNativeViewManager: vi.fn(),
  requireOptionalNativeModule: vi.fn(() => null),
}));
vi.mock('../../src/lib/customReceiptScanner', async importOriginal => {
  const actual = await importOriginal<any>();
  const React = await import('react');
  const { View } = await import('react-native');
  const Native = (props: any) => {
    mocks.nativeProps = props;
    return React.createElement(View, { testID: 'continuous-native-view' });
  };
  return { ...actual, getCustomScannerView: () => Native };
});
vi.mock('../../src/lib/api', () => ({ api: { upload: mocks.upload } }));
vi.mock('../../src/lib/receiptScannerCache', () => ({ deleteReceiptScannerFiles: mocks.cleanup }));
vi.mock('../../src/lib/receiptFilters', () => ({ applyReceiptFilter: mocks.applyReceiptFilter }));
vi.mock('../../src/lib/receiptScannerFeature', () => ({
  USE_NATIVE_RECEIPT_CAMERA: false,
  ANDROID_RECEIPT_SCANNER_ENABLED: false,
}));
vi.mock('expo-image-picker', () => ({ launchImageLibraryAsync: mocks.gallery }));
vi.mock('expo-image-manipulator', () => ({
  manipulateAsync: mocks.manipulate,
  SaveFormat: { JPEG: 'jpeg' },
}));
vi.mock('expo-camera', () => ({
  useCameraPermissions: () => [mocks.permission, mocks.request, mocks.get],
  CameraView: () => null,
}));

const originalPlatformOS = Platform.OS;
Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android' });

const { ReceiptCamera } = await import('../../src/components/receipt-camera/ReceiptCamera');
const { ThemeProvider } = await import('../../src/context/ThemeContext');

const corners = {
  topLeft: { x: 100, y: 100 },
  topRight: { x: 1100, y: 100 },
  bottomRight: { x: 1100, y: 2300 },
  bottomLeft: { x: 100, y: 2300 },
};
const payload = (name = 'receipt') => ({
  originalUri: 'file:///' + name + '-raw.jpg',
  processedUri: 'file:///' + name + '-scan.jpg',
  filterSourceUri: 'file:///' + name + '-filter-source.jpg',
  originalWidth: 1200,
  originalHeight: 2400,
  width: 1000,
  height: 2000,
  mode: 'standard',
  processingMode: 'clear-colour',
  transformVersion: 'custom-still-v2',
  corners,
});
const screen = (props: any = {}) => render(
  <ThemeProvider initialMode="dark">
    <ReceiptCamera onCancel={vi.fn()} onDone={vi.fn()} {...props} />
  </ThemeProvider>,
);

async function acceptNative(name = 'receipt', overrides: Record<string, unknown> = {}) {
  await act(async () => mocks.nativeProps.onCapture({ nativeEvent: { ...payload(name), ...overrides } }));
}

afterAll(() => {
  Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatformOS });
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.nativeProps = null;
  mocks.permission = { granted: true, canAskAgain: true };
  mocks.applyReceiptFilter.mockImplementation(async (_uri: string, mode: string) => ({
    uri: `file:///filtered-${mode}.jpg`,
    width: 900,
    height: 1800,
    processingMode: mode === 'enhanced' ? 'clear-colour' : mode,
    transformVersion: 'android-local-filter-v1',
  }));
  mocks.manipulate.mockImplementation(async (uri: string) => ({
    uri: `${uri}-edited.jpg`,
    width: 1000,
    height: 2000,
  }));
  Object.defineProperty(AppState, 'currentState', { configurable: true, value: 'active' });
});

describe('native receipt camera UI contract', () => {
  it('uses the stable modes and never lets missing edges block the shutter', async () => {
    const q = await screen();

    expect(q.getByRole('tab', { name: 'Standard scan mode' }).props.accessibilityState.selected).toBe(true);
    expect(q.getByRole('tab', { name: 'Batch scan mode' }).props.accessibilityState.selected).toBe(false);
    expect(mocks.nativeProps).toMatchObject({ mode: 'standard', autoCapture: true });
    await fireEvent.press(q.getByRole('tab', { name: 'Batch scan mode' }));
    expect(mocks.nativeProps).toMatchObject({ mode: 'standard', autoCapture: false });

    // No boundary has been seen at all: the shutter still takes the photo.
    await act(async () => mocks.nativeProps.onStatus({
      nativeEvent: { state: 'searching', message: 'Receipt edges are not clear yet · you can still take the photo' },
    }));
    expect(q.getByText('Receipt edges are not clear yet · you can still take the photo')).toBeTruthy();
    expect(q.getByRole('button', { name: 'Capture receipt' }).props.accessibilityState.disabled).toBe(false);
    await fireEvent.press(q.getByRole('button', { name: 'Capture receipt' }));
    expect(mocks.nativeProps.command.type).toBe('capture');
    const captureId = mocks.nativeProps.command.id;
    expect(q.getByText('Taking the photo…')).toBeTruthy();

    // A preview frame that still finds no edges arrives while the still is in
    // flight. It must not re-enable the shutter or send a second capture.
    await act(async () => mocks.nativeProps.onStatus({
      nativeEvent: { state: 'searching', message: 'Receipt edges are not clear yet · you can still take the photo' },
    }));
    const shutter = q.getByRole('button', { name: 'Capture receipt' });
    expect(shutter.props.accessibilityState.disabled).toBe(true);
    await fireEvent.press(shutter);
    expect(mocks.nativeProps.command.id).toBe(captureId);

    await act(async () => mocks.nativeProps.onStatus({ nativeEvent: { state: 'processing', message: 'Finding the visible receipt edges' } }));
    expect(q.getByText('Cropping and enhancing the photo…')).toBeTruthy();
    await acceptNative('partial', { cropOutcome: 'visible-section', transformVersion: 'custom-still-v3' });
    expect(q.getByRole('header', { name: 'Long receipt' })).toBeTruthy();
    expect(q.getByText('Cropped to the part of the receipt in the photo. Check that no text is cut off.')).toBeTruthy();
    expect(q.queryByTestId('continuous-native-view')).toBeNull();
  });

  it('frees the shutter again when a requested photo never arrives', async () => {
    vi.useFakeTimers();
    try {
      const q = await screen();
      await fireEvent.press(q.getByRole('tab', { name: 'Batch scan mode' }));
      await fireEvent.press(q.getByRole('button', { name: 'Capture receipt' }));
      expect(q.getByRole('button', { name: 'Capture receipt' }).props.accessibilityState.disabled).toBe(true);
      await act(async () => { vi.advanceTimersByTime(15_000); });
      expect(mocks.nativeProps.command.type).toBe('reset');
      expect(q.getByText('The photo took too long. Hold the phone steady and tap the shutter again.')).toBeTruthy();
      expect(q.getByRole('button', { name: 'Capture receipt' }).props.accessibilityState.disabled).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reviews a Standard capture with the complete edit action set', async () => {
    const done = vi.fn();
    const q = await screen({ onDone: done });

    await acceptNative('standard');

    expect(q.getByRole('header', { name: 'Review receipt' })).toBeTruthy();
    for (const label of ['Retake', 'Left', 'Filter', 'Crop', 'Delete page', 'Compare with the original photo', 'More actions', 'Use this receipt']) {
      expect(q.getByRole('button', { name: label })).toBeTruthy();
    }
    expect(q.queryByRole('button', { name: 'Add page' })).toBeNull();
    expect(done).not.toHaveBeenCalled();
    expect(mocks.upload).not.toHaveBeenCalled();
    await fireEvent.press(q.getByRole('button', { name: 'More actions' }));
    expect(q.getByRole('button', { name: 'Check quality' })).toBeTruthy();
    expect(q.getByText('Filters run on this phone. Crop and Check quality send this photo to FinSight for processing. Nothing is saved to your records until you confirm the scan.')).toBeTruthy();

    await fireEvent.press(q.getByRole('button', { name: 'Use this receipt' }));
    expect(done).toHaveBeenCalledWith([
      expect.objectContaining({
        originalUri: 'file:///standard-raw.jpg',
        processedUri: 'file:///standard-scan.jpg',
        captureMode: 'standard',
        receiptGroupId: expect.any(String),
      }),
    ]);
  });

  it('compares the edited page with the untouched photo without changing it', async () => {
    const done = vi.fn();
    const q = await screen({ onDone: done });
    await acceptNative('compare');

    await fireEvent.press(q.getByRole('button', { name: 'Compare with the original photo' }));
    expect(q.getByRole('image', { name: 'Preview of receipt' }).props.source).toEqual({ uri: 'file:///compare-raw.jpg' });
    await fireEvent.press(q.getByRole('button', { name: 'Show the edited page' }));
    expect(q.getByRole('image', { name: 'Preview of receipt' }).props.source).toEqual({ uri: 'file:///compare-scan.jpg' });
    await fireEvent.press(q.getByRole('button', { name: 'Use this receipt' }));
    expect(done.mock.calls[0]![0][0].processedUri).toBe('file:///compare-scan.jpg');
  });

  it('regenerates filters from the immutable color base and releases superseded derivatives', async () => {
    const done = vi.fn();
    const q = await screen({ onDone: done });
    await acceptNative('filter');

    await fireEvent.press(q.getByRole('button', { name: 'Filter' }));
    expect(q.getByRole('header', { name: 'Filter' })).toBeTruthy();
    expect(q.getByRole('radio', { name: 'Enhanced' }).props.accessibilityState.checked).toBe(true);
    await fireEvent.press(q.getByRole('radio', { name: 'Grayscale' }));
    await act(async () => {});

    expect(mocks.applyReceiptFilter).toHaveBeenCalledWith('file:///filter-filter-source.jpg', 'grayscale');
    expect(q.getByRole('image', { name: 'Preview of receipt' }).props.source).toEqual({ uri: 'file:///filtered-grayscale.jpg' });
    expect(mocks.cleanup).toHaveBeenCalledWith(['file:///filter-scan.jpg']);

    mocks.cleanup.mockClear();
    await fireEvent.press(q.getByRole('radio', { name: 'Original' }));
    expect(q.getByRole('image', { name: 'Preview of receipt' }).props.source).toEqual({ uri: 'file:///filter-filter-source.jpg' });
    expect(mocks.cleanup).toHaveBeenCalledWith(['file:///filtered-grayscale.jpg']);
    expect(mocks.cleanup.mock.calls.flat(2)).not.toContain('file:///filter-filter-source.jpg');

    await fireEvent.press(q.getByRole('button', { name: 'Close filters' }));
    await fireEvent.press(q.getByRole('button', { name: 'More actions' }));
    await fireEvent.press(q.getByRole('button', { name: 'Reset image' }));
    expect(q.getByRole('image', { name: 'Preview of receipt' }).props.source).toEqual({ uri: 'file:///filter-raw.jpg' });

    await fireEvent.press(q.getByRole('button', { name: 'Use this receipt' }));
    expect(done.mock.calls[0]![0][0]).toMatchObject({
      originalUri: 'file:///filter-raw.jpg',
      processedUri: 'file:///filter-raw.jpg',
      processingMode: 'original',
      captureMode: 'standard',
    });
    expect(done.mock.calls[0]![0][0].filterSourceUri).toBeUndefined();
  });

  it('turns the filter base with the page so filters still start from the unenhanced crop', async () => {
    const done = vi.fn();
    const q = await screen({ onDone: done });
    await acceptNative('geometry', { cropOutcome: 'original-fallback', transformVersion: 'custom-still-v3', processingMode: 'original', corners: undefined });
    expect(q.getByText('Receipt edges were not found, so the full photo was kept. Use Crop to adjust it, or Retake.')).toBeTruthy();

    await fireEvent.press(q.getByRole('button', { name: 'Left' }));
    await act(async () => {});
    expect(mocks.manipulate).toHaveBeenCalledWith('file:///geometry-scan.jpg', [{ rotate: -90 }], expect.anything());
    expect(mocks.manipulate).toHaveBeenCalledWith('file:///geometry-filter-source.jpg', [{ rotate: -90 }], expect.anything());
    expect(q.queryByText('Receipt edges were not found, so the full photo was kept. Use Crop to adjust it, or Retake.')).toBeNull();
    expect(q.getByRole('image', { name: 'Preview of receipt' }).props.source).toEqual({ uri: 'file:///geometry-scan.jpg-edited.jpg' });
    expect(mocks.cleanup.mock.calls.flat(2)).toContain('file:///geometry-filter-source.jpg');

    await fireEvent.press(q.getByRole('button', { name: 'Filter' }));
    await fireEvent.press(q.getByRole('radio', { name: 'Grayscale' }));
    await act(async () => {});
    expect(mocks.applyReceiptFilter).toHaveBeenCalledWith('file:///geometry-filter-source.jpg-edited.jpg', 'grayscale');
    await fireEvent.press(q.getByRole('button', { name: 'Close filters' }));
    await fireEvent.press(q.getByRole('button', { name: 'Use this receipt' }));
    expect(done.mock.calls[0]![0][0]).toMatchObject({
      processedUri: 'file:///filtered-grayscale.jpg',
      filterSourceUri: 'file:///geometry-filter-source.jpg-edited.jpg',
    });
  });

  it('enhances a manual crop with the page filter and keeps the crop as the filter base', async () => {
    const done = vi.fn();
    mocks.upload.mockResolvedValueOnce({ base64: 'AAAA', width: 900, height: 1800, transformVersion: 'server-crop-v1' });
    mocks.manipulate.mockImplementationOnce(async () => ({ uri: 'file:///cropped.jpg', width: 900, height: 1800 }));
    const q = await screen({ onDone: done });
    await acceptNative('manual-crop', { cropOutcome: 'original-fallback', transformVersion: 'custom-still-v3', processingMode: 'original', corners: undefined });

    await fireEvent.press(q.getByRole('button', { name: 'Crop' }));
    expect(q.getByRole('header', { name: 'Crop receipt' })).toBeTruthy();
    await fireEvent.press(q.getByRole('button', { name: 'Apply crop' }));
    await act(async () => {});

    expect(mocks.upload).toHaveBeenCalledWith('/records/receipts/transform', expect.anything(), expect.anything());
    expect(mocks.applyReceiptFilter).toHaveBeenCalledWith('file:///cropped.jpg', 'enhanced');
    expect(q.getByRole('image', { name: 'Preview of receipt' }).props.source).toEqual({ uri: 'file:///filtered-enhanced.jpg' });
    await fireEvent.press(q.getByRole('button', { name: 'Use this receipt' }));
    expect(done.mock.calls[0]![0][0]).toMatchObject({
      processedUri: 'file:///filtered-enhanced.jpg',
      filterSourceUri: 'file:///cropped.jpg',
      processingMode: 'clear-colour',
    });
  });

  it('preserves a retained filter base when a Batch is reduced to Standard', async () => {
    const alert = vi.spyOn(Alert, 'alert').mockImplementation(() => {});
    try {
      const q = await screen();
      await fireEvent.press(q.getByRole('tab', { name: 'Batch scan mode' }));
      await acceptNative('retained-filter');
      expect(q.queryByRole('button', { name: 'Review 1 part' })).toBeNull();
      await fireEvent.press(q.getByRole('button', { name: 'Filter' }));
      await fireEvent.press(q.getByRole('radio', { name: 'Grayscale' }));
      await act(async () => {});
      await fireEvent.press(q.getByRole('button', { name: 'Close filters' }));
      await fireEvent.press(q.getByRole('button', { name: 'Keep part' }));
      expect(q.getByRole('button', { name: 'Review 1 part' })).toBeTruthy();

      mocks.cleanup.mockClear();
      await fireEvent.press(q.getByRole('tab', { name: 'Standard scan mode' }));
      const keep = alert.mock.calls.at(-1)?.[2]?.find(button => button.text === 'Keep receipt');
      await act(async () => keep?.onPress?.());
      expect(mocks.cleanup.mock.calls.flat(2)).not.toContain('file:///retained-filter-filter-source.jpg');

      await fireEvent.press(q.getByRole('button', { name: 'Review receipt' }));
      await fireEvent.press(q.getByRole('button', { name: 'Filter' }));
      await fireEvent.press(q.getByRole('radio', { name: 'Original' }));
      expect(q.getByRole('image', { name: 'Preview of receipt' }).props.source).toEqual({ uri: 'file:///retained-filter-filter-source.jpg' });
    } finally {
      alert.mockRestore();
    }
  });

  it('preserves a retained receipt across accessibility font-size changes', async () => {
    const before = { window: Dimensions.get('window'), screen: Dimensions.get('screen') };
    const done = vi.fn();
    const q = await screen({ onDone: done });
    try {
      await acceptNative('font-scale');
      await act(async () => Dimensions.set({
        window: { ...before.window, fontScale: 1.3 },
        screen: { ...before.screen, fontScale: 1.3 },
      }));
      expect(q.getByRole('header', { name: 'Review receipt' })).toBeTruthy();
      expect(done).not.toHaveBeenCalled();
      await fireEvent.press(q.getByRole('button', { name: 'Use this receipt' }));
      expect(done).toHaveBeenCalledWith([
        expect.objectContaining({ processedUri: 'file:///font-scale-scan.jpg' }),
      ]);
    } finally {
      await act(async () => Dimensions.set(before));
    }
  });

  it('keeps a Standard image in an explicit ready state when leaving review', async () => {
    const done = vi.fn();
    const q = await screen({ onDone: done });
    await acceptNative('ready');

    await fireEvent.press(q.getByRole('button', { name: 'Back' }));
    expect(q.getByRole('header', { name: 'Receipt ready' })).toBeTruthy();
    expect(q.getByLabelText('Receipt awaiting review')).toBeTruthy();
    expect(q.queryByTestId('continuous-native-view')).toBeNull();
    expect(q.queryByRole('button', { name: 'Capture receipt' })).toBeNull();
    expect(done).not.toHaveBeenCalled();

    await fireEvent.press(q.getByRole('button', { name: 'Review receipt' }));
    await fireEvent.press(q.getByRole('button', { name: 'Use this receipt' }));
    expect(done).toHaveBeenCalledWith([
      expect.objectContaining({ processedUri: 'file:///ready-scan.jpg' }),
    ]);
  });

  it('builds one long receipt from kept Batch parts and finishes it from review', async () => {
    const done = vi.fn();
    const q = await screen({ onDone: done });

    await fireEvent.press(q.getByRole('tab', { name: 'Batch scan mode' }));
    expect(mocks.nativeProps).toMatchObject({ mode: 'standard', autoCapture: false });

    await acceptNative('first', { cropOutcome: 'original-fallback', transformVersion: 'custom-still-v3', processingMode: 'original', corners: undefined });
    expect(q.getByRole('header', { name: 'Long receipt' })).toBeTruthy();
    expect(q.getByText('1/1')).toBeTruthy();
    expect(q.getByText('Receipt edges were not found, so the full photo was kept. Use Crop to adjust it, or Retake.')).toBeTruthy();
    for (const label of ['Retake', 'Left', 'Filter', 'Crop', 'Keep part']) {
      expect(q.getByRole('button', { name: label })).toBeTruthy();
    }
    expect(q.queryByRole('button', { name: /Finish receipt/ })).toBeNull();
    expect(q.queryByRole('button', { name: 'Add part' })).toBeNull();
    expect(done).not.toHaveBeenCalled();

    await fireEvent.press(q.getByRole('button', { name: 'Keep part' }));
    // Back at the camera, ready for the next receipt.
    expect(q.getByTestId('continuous-native-view')).toBeTruthy();
    expect(mocks.nativeProps.command.type).toBe('reset');
    expect(q.getByRole('button', { name: 'Review 1 part' })).toBeTruthy();
    expect(q.getByText('Part 1 kept. Move down to the next part and keep a few lines of the last part in view.')).toBeTruthy();
    expect(done).not.toHaveBeenCalled();

    await acceptNative('second');
    expect(q.getByText('2/2')).toBeTruthy();
    await fireEvent.press(q.getByRole('button', { name: 'Retake' }));
    await acceptNative('second-retake');
    expect(q.getByRole('button', { name: 'Keep part' })).toBeTruthy();
    expect(q.queryByRole('button', { name: /Finish receipt/ })).toBeNull();
    await fireEvent.press(q.getByRole('button', { name: 'Keep part' }));

    await fireEvent.press(q.getByRole('button', { name: 'Review 2 parts' }));
    expect(q.getByText('2/2')).toBeTruthy();
    for (const label of ['Previous part', 'Next part', 'Finish receipt (2 parts)']) {
      expect(q.getByRole('button', { name: label })).toBeTruthy();
    }
    await fireEvent.press(q.getByRole('button', { name: 'Previous part' }));
    expect(q.getByText('1/2')).toBeTruthy();
    await fireEvent.press(q.getByRole('button', { name: 'Next part' }));
    await fireEvent.press(q.getByRole('button', { name: 'More actions' }));
    await fireEvent.press(q.getByRole('button', { name: 'Move part up' }));
    const finish = q.getByRole('button', { name: 'Finish receipt (2 parts)' });
    await act(async () => {
      fireEvent.press(finish);
      fireEvent.press(finish);
    });

    expect(done).toHaveBeenCalledTimes(1);
    const submitted = done.mock.calls[0]![0];
    expect(submitted.map((section: any) => section.originalUri)).toEqual([
      'file:///second-retake-raw.jpg',
      'file:///first-raw.jpg',
    ]);
    expect(new Set(submitted.map((section: any) => section.receiptGroupId)).size).toBe(1);
    expect(submitted.every((section: any) => section.captureMode === 'standard')).toBe(true);
  });

  it('adds the next part from review without losing earlier parts', async () => {
    const done = vi.fn();
    const q = await screen({ onDone: done });
    await fireEvent.press(q.getByRole('tab', { name: 'Batch scan mode' }));
    await acceptNative('one');
    await fireEvent.press(q.getByRole('button', { name: 'Keep part' }));
    await fireEvent.press(q.getByRole('button', { name: 'Review 1 part' }));

    await fireEvent.press(q.getByRole('button', { name: 'Next part' }));
    await fireEvent.press(q.getByRole('button', { name: 'Add part' }));
    expect(q.getByRole('button', { name: 'Capture receipt' })).toBeTruthy();
    await acceptNative('two');
    expect(q.getByText('2/2')).toBeTruthy();
    await fireEvent.press(q.getByRole('button', { name: 'Keep part' }));
    await fireEvent.press(q.getByRole('button', { name: 'Review 2 parts' }));
    await fireEvent.press(q.getByRole('button', { name: 'Finish receipt (2 parts)' }));
    const submitted = done.mock.calls[0]![0];
    expect(submitted.map((section: any) => section.originalUri)).toEqual(['file:///one-raw.jpg', 'file:///two-raw.jpg']);
    expect(submitted[1].receiptGroupId).toBe(submitted[0].receiptGroupId);
  });

  it('rejects malformed native output without losing the camera', async () => {
    const done = vi.fn();
    const q = await screen({ onDone: done });

    await act(async () => mocks.nativeProps.onCapture({
      nativeEvent: { ...payload('invalid'), processedUri: 'https://remote/image.jpg' },
    }));

    expect(q.getByRole('alert')).toBeTruthy();
    expect(q.getByTestId('continuous-native-view')).toBeTruthy();
    expect(done).not.toHaveBeenCalled();
    expect(mocks.nativeProps.command.type).toBe('reset');
  });

  it('rejects native callbacks retained across a mode switch', async () => {
    const q = await screen();
    const stale = mocks.nativeProps;

    await fireEvent.press(q.getByRole('tab', { name: 'Batch scan mode' }));
    await act(async () => {
      stale.onStatus({ nativeEvent: { state: 'processing', message: 'Stale mode event' } });
      stale.onCapture({ nativeEvent: payload('stale-mode') });
    });

    expect(q.queryByText('Stale mode event')).toBeNull();
    expect(q.queryByRole('button', { name: 'Review 1 part' })).toBeNull();
    expect(q.getByRole('tab', { name: 'Batch scan mode' }).props.accessibilityState.selected).toBe(true);
    expect(q.getByRole('button', { name: 'Capture receipt' })).toBeTruthy();
  });

  it('prompts before discarding a pending capture and rejects its stale native callback', async () => {
    const alert = vi.spyOn(Alert, 'alert').mockImplementation(() => {});
    try {
      const q = await screen();
      await fireEvent.press(q.getByRole('tab', { name: 'Batch scan mode' }));
      await acceptNative('deleted');
      const stale = mocks.nativeProps;
      await fireEvent.press(q.getByRole('button', { name: 'Back' }));
      expect(alert).toHaveBeenLastCalledWith(
        'Discard this unconfirmed part?',
        expect.stringContaining('not been added to the receipt'),
        expect.any(Array),
      );
      const remove = alert.mock.calls.at(-1)?.[2]?.find(button => button.text === 'Discard photo');
      await act(async () => remove?.onPress?.());

      expect(q.queryByRole('button', { name: 'Review 1 part' })).toBeNull();
      await act(async () => {
        stale.onStatus({ nativeEvent: { state: 'processing', message: 'Deleted receipt event' } });
        stale.onCapture({ nativeEvent: payload('deleted-stale') });
      });
      expect(q.queryByText('Deleted receipt event')).toBeNull();
      expect(q.queryByRole('button', { name: 'Review 1 part' })).toBeNull();
      expect(q.getByRole('button', { name: 'Capture receipt' })).toBeTruthy();
    } finally {
      alert.mockRestore();
    }
  });

  it('does not accept a queued native event after backgrounding', async () => {
    const listeners: ((state: AppStateStatus) => void)[] = [];
    const spy = vi.spyOn(AppState, 'addEventListener').mockImplementation((_type, listener) => {
      listeners.push(listener);
      return { remove: vi.fn() };
    });
    try {
      const q = await screen();
      const stale = mocks.nativeProps.onCapture;
      await act(async () => listeners[0]!('background'));
      await act(async () => stale({ nativeEvent: payload('background') }));
      expect(q.queryByRole('button', { name: 'Use this receipt' })).toBeNull();

      await act(async () => listeners[0]!('active'));
      await act(async () => stale({ nativeEvent: payload('foreground') }));
      expect(q.queryByRole('button', { name: 'Use this receipt' })).toBeNull();
      expect(q.queryByRole('button', { name: 'Review 1 part' })).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  it('cleans abandoned native files but leaves handed-off files to the parent', async () => {
    const abandoned = await screen();
    await acceptNative('abandoned');
    mocks.cleanup.mockClear();
    await act(async () => abandoned.unmount());
    expect(mocks.cleanup).toHaveBeenCalledWith([
      'file:///abandoned-raw.jpg',
      'file:///abandoned-scan.jpg',
      'file:///abandoned-filter-source.jpg',
    ]);

    const handedOff = await screen();
    await acceptNative('handed-off');
    await fireEvent.press(handedOff.getByRole('button', { name: 'Use this receipt' }));
    mocks.cleanup.mockClear();
    await act(async () => handedOff.unmount());
    expect(mocks.cleanup).not.toHaveBeenCalled();
  });
});
