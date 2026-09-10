import React, { createRef } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render } from '@testing-library/react-native';
import { AppState, Alert } from 'react-native';

const mocks = vi.hoisted(() => ({
  permission: { granted: true, canAskAgain: true },
  request: vi.fn(async () => undefined), get: vi.fn(async () => undefined),
  picture: vi.fn(), gallery: vi.fn(), manipulate: vi.fn(), upload: vi.fn(),
}));
vi.mock('../../src/lib/api', () => ({ api: { upload: mocks.upload } }));
vi.mock('../../src/lib/customReceiptScanner', () => ({ getCustomScannerView: () => null }));
vi.mock('../../src/lib/receiptScannerFeature', () => ({ USE_NATIVE_RECEIPT_CAMERA: false, ANDROID_RECEIPT_SCANNER_ENABLED: false }));
vi.mock('expo-image-picker', () => ({ launchImageLibraryAsync: mocks.gallery }));
vi.mock('expo-image-manipulator', () => ({ manipulateAsync: mocks.manipulate, SaveFormat: { JPEG: 'jpeg' } }));
vi.mock('expo-camera', async () => {
  const React = await import('react'); const { View } = await import('react-native');
  return { useCameraPermissions: () => [mocks.permission, mocks.request, mocks.get],
    CameraView: React.forwardRef((props: any, ref: any) => {
      React.useImperativeHandle(ref, () => ({ takePictureAsync: mocks.picture }));
      // Model one readiness event per native camera mount.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      React.useEffect(() => { props.onCameraReady(); }, []);
      return <View testID="native-camera-mock" />;
    }),
  };
});
const { ReceiptCamera } = await import('../../src/components/receipt-camera/ReceiptCamera');
const { ThemeProvider } = await import('../../src/context/ThemeContext');
const { createReceiptSection } = await import('../../src/lib/receiptCameraSession');

beforeEach(() => {
  vi.clearAllMocks(); mocks.permission = { granted: true, canAskAgain: true };
  Object.defineProperty(AppState, 'currentState', { configurable: true, value: 'active' });
  mocks.picture.mockResolvedValue({ uri: 'file:///captured.jpg', width: 1200, height: 2400 });
  mocks.gallery.mockResolvedValue({ canceled: true });
  mocks.manipulate.mockImplementation(async (uri: string) => ({ uri: `${uri}-normalized.jpg`, width: 1200, height: 2400 }));
});
const screen = (props: any = {}) => render(<ThemeProvider initialMode="dark"><ReceiptCamera onCancel={vi.fn()} onDone={vi.fn()} {...props} /></ThemeProvider>);

describe('custom scanner interaction contract (native camera mocked)', () => {
  it('offers gallery and long-receipt mode directly beside the camera', async () => {
    const q = await screen();
    expect(q.getByRole('button', { name: 'Gallery' })).toBeTruthy();
    await fireEvent.press(q.getByRole('tab', { name: 'Manual sections' }));
    expect(q.getByRole('tab', { name: 'Manual sections' }).props.accessibilityState.selected).toBe(true);
    expect(mocks.upload).not.toHaveBeenCalled();
  });
  it('keeps gallery available when camera access is permanently denied', async () => {
    mocks.permission = { granted: false, canAskAgain: false };
    const q = await screen();
    expect(q.getByRole('button', { name: 'Open settings' })).toBeTruthy();
    await fireEvent.press(q.getByRole('button', { name: 'Gallery' }));
    expect(mocks.gallery).toHaveBeenCalledTimes(1);
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it('captures locally, prevents two concurrent shutters, and requires explicit approval', async () => {
    let resolve!: (value: any) => void;
    mocks.picture.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
    const done = vi.fn(); const q = await screen({ onDone: done });
    await act(async () => {
      const shutter = q.getByRole('button', { name: 'Capture receipt section' });
      await fireEvent.press(shutter); await fireEvent.press(shutter);
    });
    expect(mocks.picture).toHaveBeenCalledTimes(1);
    await act(async () => resolve({ uri: 'file:///captured.jpg', width: 1200, height: 2400 }));
    expect(done).not.toHaveBeenCalled(); expect(mocks.upload).not.toHaveBeenCalled();
    await fireEvent.press(q.getByRole('button', { name: 'Use this receipt' }));
    expect(done).toHaveBeenCalledWith([expect.objectContaining({ captureSource: 'manual-camera', originalUri: 'file:///captured.jpg' })]);
  });
  it('imports multiple selected images in long mode and returns them in order', async () => {
    mocks.gallery.mockResolvedValue({ canceled: false, assets: [{ uri: 'file:///a.png' }, { uri: 'file:///b.png' }] });
    const done = vi.fn(); const q = await screen({ onDone: done });
    await fireEvent.press(q.getByRole('tab', { name: 'Manual sections' }));
    await fireEvent.press(q.getByRole('button', { name: 'Gallery' }));
    await act(async () => {});
    expect(mocks.gallery).toHaveBeenCalledWith(expect.objectContaining({ allowsMultipleSelection: true, selectionLimit: 8 }));
    await fireEvent.press(q.getByRole('button', { name: 'Use 2 sections' }));
    expect(done.mock.calls[0]![0].map((s: any) => s.originalUri)).toEqual(['file:///a.png-normalized.jpg', 'file:///b.png-normalized.jpg']);
  });
  it('retakes the selected page in place, preserving all other pages', async () => {
    const a = createReceiptSection({ uri: 'file:///a.jpg', width: 1200, height: 2400 }, 'manual-camera');
    const b = createReceiptSection({ uri: 'file:///b.jpg', width: 1200, height: 2400 }, 'gallery');
    const done = vi.fn(); const q = await screen({ initialSections: [a, b], onDone: done });
    await fireEvent.press(q.getByRole('button', { name: 'Review section 1' }));
    await fireEvent.press(q.getByRole('button', { name: 'Retake' }));
    await act(async () => {});
    await fireEvent.press(q.getByRole('button', { name: 'Capture receipt section' }));
    await act(async () => {});
    await fireEvent.press(q.getByRole('button', { name: 'Use 2 sections' }));
    expect(done.mock.calls[0]![0]).toEqual([expect.objectContaining({ localId: a.localId, originalUri: 'file:///captured.jpg' }), b]);
  });
  it('shows a quality service failure without losing the captured image', async () => {
    mocks.upload.mockRejectedValue(new Error('Connection unavailable. Try again.'));
    const q = await screen();
    await fireEvent.press(q.getByRole('button', { name: 'Capture receipt section' }));
    await act(async () => {});
    await fireEvent.press(q.getByRole('button', { name: 'Check quality' }));
    await act(async () => {});
    expect(q.getByRole('alert')).toBeTruthy();
    expect(q.getByRole('button', { name: 'Use this receipt' })).toBeTruthy();
  });
  it('routes modal back through review and discard confirmation', async () => {
    const ref = createRef<any>(); const cancel = vi.fn(); const alert = vi.spyOn(Alert, 'alert');
    const q = await screen({ ref, onCancel: cancel });
    await fireEvent.press(q.getByRole('button', { name: 'Capture receipt section' }));
    await act(async () => {});
    await act(async () => ref.current.requestClose());
    expect(cancel).not.toHaveBeenCalled();
    await act(async () => ref.current.requestClose());
    expect(alert).toHaveBeenCalledWith('Discard this capture session?', expect.any(String), expect.any(Array));
    alert.mockRestore();
  });
  it('cancels a pending quality request and ignores its late response without losing pages', async () => {
    const ref = createRef<any>(); let resolve!: (quality: any) => void;
    mocks.upload.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
    const q = await screen({ ref });
    await fireEvent.press(q.getByRole('button', { name: 'Capture receipt section' }));
    await act(async () => {});
    await fireEvent.press(q.getByRole('button', { name: 'Check quality' }));
    expect(q.getByRole('button', { name: 'Back' }).props.accessibilityState.disabled).toBe(false);
    const signal = mocks.upload.mock.calls[0]![2] as AbortSignal;
    await act(async () => ref.current.requestClose());
    expect(signal.aborted).toBe(true);
    await fireEvent.press(q.getByRole('button', { name: 'Review section 1' }));
    await act(async () => resolve({ sharpness: 0, brightness: 0, tooBlurredToTrust: true }));
    expect(q.queryByText(/may be blurry/)).toBeNull();
    expect(q.getByRole('button', { name: 'Use this receipt' })).toBeTruthy();
  });
});
