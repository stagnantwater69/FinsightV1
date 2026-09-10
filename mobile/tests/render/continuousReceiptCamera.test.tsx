import React, { createRef } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render } from '@testing-library/react-native';
import { Alert, AppState, Dimensions, type AppStateStatus } from 'react-native';

const mocks = vi.hoisted(() => ({ nativeProps: null as any, permission: { granted: true, canAskAgain: true }, request: vi.fn(), get: vi.fn(async () => undefined), upload: vi.fn(), gallery: vi.fn(async () => ({ canceled: true })) }));
vi.mock('expo-modules-core', () => ({ requireNativeViewManager: vi.fn(), requireOptionalNativeModule: vi.fn(() => null) }));
vi.mock('../../src/lib/customReceiptScanner', async importOriginal => {
  const actual = await importOriginal<any>(); const React = await import('react'); const { View } = await import('react-native');
  const Native = (props: any) => { mocks.nativeProps = props; return React.createElement(View, { testID: 'continuous-native-view' }); };
  return { ...actual, getCustomScannerView: () => Native };
});
vi.mock('../../src/lib/api', () => ({ api: { upload: mocks.upload } }));
vi.mock('../../src/lib/receiptScannerFeature', () => ({ USE_NATIVE_RECEIPT_CAMERA: false, ANDROID_RECEIPT_SCANNER_ENABLED: false }));
vi.mock('expo-image-picker', () => ({ launchImageLibraryAsync: mocks.gallery }));
vi.mock('expo-image-manipulator', () => ({ manipulateAsync: vi.fn(), SaveFormat: { JPEG: 'jpeg' } }));
vi.mock('expo-camera', () => ({ useCameraPermissions: () => [mocks.permission, mocks.request, mocks.get], CameraView: () => null }));
const { ReceiptCamera } = await import('../../src/components/receipt-camera/ReceiptCamera');
const { ThemeProvider } = await import('../../src/context/ThemeContext');
const payload = (mode = 'standard') => ({ originalUri: 'file:///raw.jpg', processedUri: 'file:///scan.jpg', originalWidth: 1200, originalHeight: 2400, width: 1000, height: 2000, mode, transformVersion: mode === 'long' ? 'custom-panorama-v1' : 'custom-frame-v1' });
const screen = (props: any = {}) => render(<ThemeProvider initialMode="dark"><ReceiptCamera onCancel={vi.fn()} onDone={vi.fn()} {...props} /></ThemeProvider>);
beforeEach(() => { vi.clearAllMocks(); mocks.nativeProps = null; Object.defineProperty(AppState, 'currentState', { configurable: true, value: 'active' }); });

describe('continuous scanner UI contract (native pixels mocked)', () => {
  it('acknowledges manual capture and shows detection recovery without leaving the camera', async () => {
    const q = await screen();
    await fireEvent.press(q.getByRole('button', { name: 'Capture now' }));
    expect(mocks.nativeProps.command.type).toBe('capture');
    expect(q.getByText('Checking receipt edges. Keep all four corners visible and hold still.')).toBeTruthy();
    await act(async () => mocks.nativeProps.onStatus({ nativeEvent: { state: 'searching', message: 'Show all four receipt corners, then tap Capture now again.' } }));
    expect(q.getByText('Show all four receipt corners, then tap Capture now again.')).toBeTruthy();
    expect(q.getByRole('button', { name: 'Capture now' }).props.accessibilityState.disabled).toBe(false);
    expect(q.getByTestId('continuous-native-view')).toBeTruthy();
  });
  it('reviews an automatically completed long scan without requiring Finish', async () => {
    const done = vi.fn(); const q = await screen({ onDone: done });
    await fireEvent.press(q.getByRole('tab', { name: 'Long receipt' }));
    await fireEvent.press(q.getByRole('button', { name: 'Start scanning' }));
    await act(async () => mocks.nativeProps.onStatus({ nativeEvent: { state: 'processing', message: 'Preparing your receipt on this device', acceptedHeight: 3000 } }));
    await act(async () => mocks.nativeProps.onCapture({ nativeEvent: payload('long') }));
    expect(q.getByRole('header', { name: 'Review receipt' })).toBeTruthy();
    expect(done).not.toHaveBeenCalled();
    expect(mocks.upload).not.toHaveBeenCalled();
  });
  it('preserves the retained receipt across accessibility font-size changes', async () => {
    const before = { window: Dimensions.get('window'), screen: Dimensions.get('screen') };
    const done = vi.fn(); const q = await screen({ onDone: done });
    try {
      await act(async () => mocks.nativeProps.onCapture({ nativeEvent: payload() }));
      await act(async () => Dimensions.set({ window: { ...before.window, fontScale: 1.3 }, screen: { ...before.screen, fontScale: 1.3 } }));
      expect(q.getByRole('header', { name: 'Review receipt' })).toBeTruthy();
      expect(done).not.toHaveBeenCalled();
      await fireEvent.press(q.getByRole('button', { name: 'Use this receipt' }));
      expect(done).toHaveBeenCalledWith([expect.objectContaining({ processedUri: 'file:///scan.jpg' })]);
    } finally { await act(async () => Dimensions.set(before)); }
  });
  it('keeps the image in an explicit ready state when leaving review', async () => {
    const done = vi.fn(); const q = await screen({ onDone: done });
    await act(async () => mocks.nativeProps.onCapture({ nativeEvent: payload() }));
    await fireEvent.press(q.getByRole('button', { name: 'Back' }));
    expect(q.getByRole('header', { name: 'Receipt ready' })).toBeTruthy();
    expect(q.getByLabelText('Receipt awaiting review')).toBeTruthy();
    expect(q.queryByTestId('continuous-native-view')).toBeNull();
    expect(q.queryByRole('button', { name: 'Capture now' })).toBeNull();
    expect(done).not.toHaveBeenCalled();
    await fireEvent.press(q.getByRole('button', { name: 'Review receipt' }));
    expect(q.getByRole('header', { name: 'Review receipt' })).toBeTruthy();
    await fireEvent.press(q.getByRole('button', { name: 'Use this receipt' }));
    expect(done).toHaveBeenCalledWith([expect.objectContaining({ processedUri: 'file:///scan.jpg' })]);
  });
  it('reviews automatic standard capture without uploading or approving it', async () => {
    const done = vi.fn(); const q = await screen({ onDone: done });
    const originalCallback = mocks.nativeProps.onCapture;
    await act(async () => originalCallback({ nativeEvent: payload() }));
    expect(q.getByRole('header', { name: 'Review receipt' })).toBeTruthy();
    expect(done).not.toHaveBeenCalled(); expect(mocks.upload).not.toHaveBeenCalled();
    await act(async () => originalCallback({ nativeEvent: payload() }));
    await fireEvent.press(q.getByRole('button', { name: 'Use this receipt' }));
    expect(done).toHaveBeenCalledWith([expect.objectContaining({ originalUri: 'file:///raw.jpg', processedUri: 'file:///scan.jpg', captureMode: 'standard' })]);
  });
  it('starts and finishes long capture into one reviewed image, not manual pages', async () => {
    const done = vi.fn(); const q = await screen({ onDone: done });
    await fireEvent.press(q.getByRole('tab', { name: 'Long receipt' }));
    await fireEvent.press(q.getByRole('button', { name: 'Start scanning' }));
    expect(mocks.nativeProps.command.type).toBe('start');
    expect(q.getByRole('button', { name: 'Gallery' }).props.accessibilityState.disabled).toBe(true);
    await act(async () => mocks.nativeProps.onStatus({ nativeEvent: { state: 'scanning', message: 'Move slowly down', acceptedHeight: 1800 } }));
    await fireEvent.press(q.getByRole('button', { name: 'Finish scan' }));
    expect(mocks.nativeProps.command.type).toBe('finish');
    await act(async () => mocks.nativeProps.onCapture({ nativeEvent: payload('long') }));
    expect(q.queryByRole('button', { name: 'Add section' })).toBeNull();
    expect(done).not.toHaveBeenCalled();
    await fireEvent.press(q.getByRole('button', { name: 'Use this receipt' }));
    expect(done.mock.calls[0][0]).toHaveLength(1);
    expect(done.mock.calls[0][0][0].transformVersion).toBe('custom-panorama-v1');
  });
  it('rejects malformed native output without losing the camera', async () => {
    const done = vi.fn(); const q = await screen({ onDone: done });
    await act(async () => mocks.nativeProps.onCapture({ nativeEvent: { ...payload(), processedUri: 'https://remote/image.jpg' } }));
    expect(q.getByRole('alert')).toBeTruthy(); expect(q.getByTestId('continuous-native-view')).toBeTruthy();
    expect(done).not.toHaveBeenCalled();
    expect(mocks.nativeProps.command.type).toBe('reset');
  });
  it('rejects old mode status and capture callbacks after switching modes', async () => {
    const q = await screen(); const old = mocks.nativeProps;
    await fireEvent.press(q.getByRole('tab', { name: 'Long receipt' }));
    await act(async () => {
      old.onStatus({ nativeEvent: { state: 'processing', message: 'Old capture finishing' } });
      old.onCapture({ nativeEvent: payload() });
    });
    expect(q.queryByText('Old capture finishing')).toBeNull();
    expect(q.getByRole('button', { name: 'Start scanning' }).props.accessibilityState.disabled).toBe(false);
  });
  it.each(['standard', 'long'])('labels %s native evidence as unenhanced and preserves provenance', async mode => {
    const done = vi.fn(); const q = await screen({ onDone: done });
    if (mode === 'long') {
      await fireEvent.press(q.getByRole('tab', { name: 'Long receipt' }));
      await fireEvent.press(q.getByRole('button', { name: 'Start scanning' }));
    }
    await act(async () => mocks.nativeProps.onCapture({ nativeEvent: payload(mode) }));
    expect(q.queryByRole('button', { name: 'Use original' })).toBeNull();
    await fireEvent.press(q.getByRole('button', { name: 'Use unenhanced scan' }));
    await fireEvent.press(q.getByRole('button', { name: 'Use this receipt' }));
    expect(done.mock.calls[0][0][0]).toMatchObject({ processedUri: 'file:///raw.jpg', captureMode: mode, transformVersion: payload(mode).transformVersion, processingMode: 'original' });
  });
  it('allows finishing again when the native engine asks to show the bottom edge', async () => {
    const q = await screen();
    await fireEvent.press(q.getByRole('tab', { name: 'Long receipt' }));
    await fireEvent.press(q.getByRole('button', { name: 'Start scanning' }));
    await act(async () => mocks.nativeProps.onStatus({ nativeEvent: { state: 'scanning', message: 'Move slowly down', acceptedHeight: 1800 } }));
    await fireEvent.press(q.getByRole('button', { name: 'Finish scan' }));
    await act(async () => mocks.nativeProps.onStatus({ nativeEvent: { state: 'tracking', message: 'Show the bottom edge and hold still before finishing' } }));
    expect(q.getByRole('button', { name: 'Finish scan' }).props.accessibilityState.disabled).toBe(false);
  });
  it('keeps Finish disabled until receipt pixels are accepted and preserves them while tracking', async () => {
    const q = await screen();
    await fireEvent.press(q.getByRole('tab', { name: 'Long receipt' }));
    await fireEvent.press(q.getByRole('button', { name: 'Start scanning' }));
    expect(q.getByText('Waiting for the top edge')).toBeTruthy();
    expect(q.getByRole('button', { name: 'Finish scan' }).props.accessibilityState.disabled).toBe(true);
    await fireEvent.press(q.getByRole('button', { name: 'Finish scan' }));
    expect(mocks.nativeProps.command.type).toBe('start');
    await act(async () => mocks.nativeProps.onStatus({ nativeEvent: { state: 'scanning', message: 'Find the top', acceptedHeight: 0, progress: 0.5 } }));
    expect(q.getByRole('button', { name: 'Finish scan' }).props.accessibilityState.disabled).toBe(true);
    await act(async () => mocks.nativeProps.onStatus({ nativeEvent: { state: 'scanning', message: 'Move slowly down', acceptedHeight: 1800 } }));
    expect(q.getByText('Receipt captured so far')).toBeTruthy();
    expect(q.getByRole('button', { name: 'Finish scan' }).props.accessibilityState.disabled).toBe(false);
    await act(async () => mocks.nativeProps.onStatus({ nativeEvent: { state: 'tracking', message: 'Hold steady' } }));
    expect(q.getByText('Receipt captured so far')).toBeTruthy();
    expect(q.getByRole('button', { name: 'Finish scan' }).props.accessibilityState.disabled).toBe(false);
  });
  it('accepts legacy positive scanning progress without treating tracking progress as captured pixels', async () => {
    const q = await screen();
    await fireEvent.press(q.getByRole('tab', { name: 'Long receipt' }));
    await fireEvent.press(q.getByRole('button', { name: 'Start scanning' }));
    await act(async () => mocks.nativeProps.onStatus({ nativeEvent: { state: 'tracking', message: 'Hold steady', progress: 0.5 } }));
    expect(q.getByRole('button', { name: 'Finish scan' }).props.accessibilityState.disabled).toBe(true);
    await act(async () => mocks.nativeProps.onStatus({ nativeEvent: { state: 'scanning', message: 'Move slowly down', progress: 0.1 } }));
    expect(q.getByRole('button', { name: 'Finish scan' }).props.accessibilityState.disabled).toBe(false);
  });
  it('keeps a continuous capture to one image and enables gallery only for replacement', async () => {
    const q = await screen();
    await act(async () => mocks.nativeProps.onCapture({ nativeEvent: payload() }));
    await fireEvent.press(q.getByRole('button', { name: 'Back' }));
    expect(q.queryByRole('button', { name: 'Gallery' })).toBeNull();
    await fireEvent.press(q.getByRole('button', { name: 'Review receipt' }));
    await fireEvent.press(q.getByRole('button', { name: 'Retake' }));
    expect(q.getByRole('button', { name: 'Gallery' }).props.accessibilityState.disabled).toBe(false);
  });
  it('does not accept an already queued event after backgrounding', async () => {
    const listeners: ((state: AppStateStatus) => void)[] = [];
    const spy = vi.spyOn(AppState, 'addEventListener').mockImplementation((_type, listener) => { listeners.push(listener); return { remove: vi.fn() }; });
    const q = await screen(); const stale = mocks.nativeProps.onCapture;
    await act(async () => listeners[0]('background'));
    await act(async () => stale({ nativeEvent: payload() }));
    expect(q.queryByRole('button', { name: 'Use this receipt' })).toBeNull();
    await act(async () => listeners[0]('active'));
    await act(async () => stale({ nativeEvent: payload() }));
    expect(q.queryByRole('button', { name: 'Use this receipt' })).toBeNull();
    spy.mockRestore();
  });
  it('recovers the primary action when the engine returns a result for another mode', async () => {
    const q = await screen();
    await fireEvent.press(q.getByRole('tab', { name: 'Long receipt' }));
    await fireEvent.press(q.getByRole('button', { name: 'Start scanning' }));
    await act(async () => mocks.nativeProps.onStatus({ nativeEvent: { state: 'processing', message: 'Preparing your receipt on this device', acceptedHeight: 3000 } }));
    expect(q.getByRole('button', { name: 'Finishing…' }).props.accessibilityState.disabled).toBe(true);
    await act(async () => mocks.nativeProps.onCapture({ nativeEvent: payload('standard') }));
    expect(q.queryByRole('header', { name: 'Review receipt' })).toBeNull();
    expect(q.queryByRole('button', { name: 'Finishing…' })).toBeNull();
    expect(q.getByRole('button', { name: 'Start scanning' }).props.accessibilityState.disabled).toBe(false);
    expect(mocks.nativeProps.command.type).toBe('reset');
  });
  it('Back offers discard during continuous capture and rejects discarded completion', async () => {
    const ref = createRef<any>(); const q = await screen({ ref });
    await fireEvent.press(q.getByRole('tab', { name: 'Long receipt' }));
    await fireEvent.press(q.getByRole('button', { name: 'Start scanning' }));
    await act(async () => mocks.nativeProps.onStatus({ nativeEvent: { state: 'scanning', message: 'Move slowly down', acceptedHeight: 1800 } }));
    const staleStatus = mocks.nativeProps.onStatus;
    const stale = mocks.nativeProps.onCapture; const alert = vi.spyOn(Alert, 'alert').mockImplementation(() => {});
    await act(async () => ref.current.requestClose());
    expect(alert).toHaveBeenCalledWith('Discard the current scan?', expect.any(String), expect.any(Array));
    const discard = alert.mock.calls[0][2]?.find(button => button.text === 'Discard scan');
    await act(async () => discard?.onPress?.());
    await act(async () => stale({ nativeEvent: payload('long') }));
    expect(q.queryByRole('button', { name: 'Use this receipt' })).toBeNull();
    expect(q.getByRole('button', { name: 'Start scanning' })).toBeTruthy();
    await fireEvent.press(q.getByRole('button', { name: 'Start scanning' }));
    await act(async () => staleStatus({ nativeEvent: { state: 'scanning', message: 'Discarded progress', acceptedHeight: 2400 } }));
    expect(q.queryByText('Discarded progress')).toBeNull();
    expect(q.getByText('Waiting for the top edge')).toBeTruthy();
    expect(q.getByRole('button', { name: 'Finish scan' }).props.accessibilityState.disabled).toBe(true);
    alert.mockRestore();
  });
});
