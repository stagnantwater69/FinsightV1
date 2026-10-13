import React, { createRef } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render } from '@testing-library/react-native';
import { Alert, AppState } from 'react-native';

const mocks = vi.hoisted(() => ({
  permission: { granted: true, canAskAgain: true },
  request: vi.fn(async () => undefined),
  get: vi.fn(async () => undefined),
  picture: vi.fn(),
  gallery: vi.fn(),
  manipulate: vi.fn(),
  upload: vi.fn(),
}));

vi.mock('../../src/lib/api', () => ({ api: { upload: mocks.upload } }));
vi.mock('../../src/lib/customReceiptScanner', () => ({ getCustomScannerView: () => null, isCustomScannerOutdated: () => false }));
vi.mock('../../src/lib/receiptScannerFeature', () => ({ USE_NATIVE_RECEIPT_CAMERA: false, ANDROID_RECEIPT_SCANNER_ENABLED: false }));
vi.mock('expo-image-picker', () => ({ launchImageLibraryAsync: mocks.gallery }));
vi.mock('expo-image-manipulator', () => ({ manipulateAsync: mocks.manipulate, SaveFormat: { JPEG: 'jpeg' } }));
vi.mock('expo-camera', async () => {
  const React = await import('react');
  const { View } = await import('react-native');
  return {
    useCameraPermissions: () => [mocks.permission, mocks.request, mocks.get],
    CameraView: React.forwardRef((props: any, ref: any) => {
      React.useImperativeHandle(ref, () => ({ takePictureAsync: mocks.picture }));
      const onCameraReady = React.useRef(props.onCameraReady);
      React.useEffect(() => { onCameraReady.current(); }, []);
      return <View testID="native-camera-mock" />;
    }),
  };
});

const { ReceiptCamera } = await import('../../src/components/receipt-camera/ReceiptCamera');
const { ThemeProvider } = await import('../../src/context/ThemeContext');
const { createReceiptSection } = await import('../../src/lib/receiptCameraSession');

beforeEach(() => {
  vi.clearAllMocks();
  mocks.permission = { granted: true, canAskAgain: true };
  Object.defineProperty(AppState, 'currentState', { configurable: true, value: 'active' });
  mocks.picture.mockResolvedValue({ uri: 'file:///captured.jpg', width: 1200, height: 2400 });
  mocks.gallery.mockResolvedValue({ canceled: true });
  mocks.manipulate.mockImplementation(async (uri: string) => ({ uri: uri + '-normalized.jpg', width: 1200, height: 2400 }));
});

const screen = (props: any = {}) => render(
  <ThemeProvider initialMode="dark">
    <ReceiptCamera onCancel={vi.fn()} onDone={vi.fn()} {...props} />
  </ThemeProvider>,
);

async function capture(q: Awaited<ReturnType<typeof screen>>) {
  await fireEvent.press(q.getByRole('button', { name: 'Capture receipt' }));
  await act(async () => {});
}

describe('receipt camera fallback contract', () => {
  it('offers the stable Standard and Batch capture modes', async () => {
    const q = await screen();

    expect(q.getByRole('tab', { name: 'Standard scan mode' }).props.accessibilityState.selected).toBe(true);
    expect(q.getByRole('tab', { name: 'Batch scan mode' }).props.accessibilityState.selected).toBe(false);
    expect(q.getByRole('button', { name: 'Gallery' })).toBeTruthy();
    expect(q.getByRole('button', { name: 'Capture receipt' })).toBeTruthy();
    expect(q.getByText('Take the photo, then use Crop to trim it. Automatic cropping is not in this build.')).toBeTruthy();

    await fireEvent.press(q.getByRole('tab', { name: 'Batch scan mode' }));
    expect(q.getByRole('tab', { name: 'Batch scan mode' }).props.accessibilityState.selected).toBe(true);
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

  it('captures locally, prevents concurrent shutters, and waits for explicit approval', async () => {
    let resolve!: (value: any) => void;
    mocks.picture.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
    const done = vi.fn();
    const q = await screen({ onDone: done });

    await act(async () => {
      const shutter = q.getByRole('button', { name: 'Capture receipt' });
      fireEvent.press(shutter);
      fireEvent.press(shutter);
    });
    expect(mocks.picture).toHaveBeenCalledTimes(1);

    await act(async () => resolve({ uri: 'file:///captured.jpg', width: 1200, height: 2400 }));
    expect(done).not.toHaveBeenCalled();
    expect(mocks.upload).not.toHaveBeenCalled();
    for (const label of ['Retake', 'Left', 'Crop', 'Delete page', 'More actions', 'Use this receipt']) {
      expect(q.getByRole('button', { name: label })).toBeTruthy();
    }
    // Filters come from the Android scanner module, which this build lacks.
    expect(q.queryByRole('button', { name: 'Filter' })).toBeNull();

    const approve = q.getByRole('button', { name: 'Use this receipt' });
    await act(async () => {
      fireEvent.press(approve);
      fireEvent.press(approve);
    });
    expect(done).toHaveBeenCalledTimes(1);
    expect(done).toHaveBeenCalledWith([
      expect.objectContaining({ captureSource: 'manual-camera', originalUri: 'file:///captured.jpg' }),
    ]);
  });

  it('keeps a fallback Standard capture ready for review after leaving it', async () => {
    const q = await screen();
    await capture(q);

    expect(q.getByRole('header', { name: 'Review receipt' })).toBeTruthy();
    expect(q.getByText('1/1')).toBeTruthy();
    await fireEvent.press(q.getByRole('button', { name: 'More actions' }));
    expect(q.getByText('Crop and Check quality send this photo to FinSight for processing. Nothing is saved to your records until you confirm the scan.')).toBeTruthy();
    await fireEvent.press(q.getByRole('button', { name: 'Back' }));
    await fireEvent.press(q.getByRole('button', { name: 'Back' }));

    expect(q.getByRole('header', { name: 'Receipt ready' })).toBeTruthy();
    expect(q.getByRole('button', { name: 'Review receipt' })).toBeTruthy();
    expect(q.queryByRole('button', { name: 'Capture receipt' })).toBeNull();
  });

  it('confirms deletion of a Standard receipt before removing it', async () => {
    const alert = vi.spyOn(Alert, 'alert').mockImplementation(() => {});
    try {
      const q = await screen();
      await capture(q);

      await fireEvent.press(q.getByRole('button', { name: 'Delete page' }));
      expect(alert).toHaveBeenCalledWith(
        'Delete this receipt?',
        'This removes the captured receipt and returns to the camera.',
        expect.any(Array),
      );
      expect(q.getByRole('button', { name: 'Use this receipt' })).toBeTruthy();

      const remove = alert.mock.calls.at(-1)?.[2]?.find(button => button.text === 'Delete');
      await act(async () => remove?.onPress?.());
      expect(q.queryByRole('button', { name: 'Use this receipt' })).toBeNull();
      expect(q.getByRole('button', { name: 'Capture receipt' })).toBeTruthy();
    } finally {
      alert.mockRestore();
    }
  });

  it('adds Batch gallery photos one part at a time to the same long receipt', async () => {
    mocks.gallery.mockResolvedValue({
      canceled: false,
      assets: [{ uri: 'file:///overflow-a.png' }, { uri: 'file:///overflow-b.png' }],
    });
    const q = await screen({ maxReceipts: 1 });

    await fireEvent.press(q.getByRole('tab', { name: 'Batch scan mode' }));
    await capture(q);
    expect(q.queryByRole('button', { name: 'Review 1 part' })).toBeNull();
    expect(q.queryByRole('button', { name: /Finish receipt/ })).toBeNull();
    await fireEvent.press(q.getByRole('button', { name: 'Keep part' }));
    expect(q.getByRole('button', { name: 'Review 1 part' })).toBeTruthy();
    await fireEvent.press(q.getByRole('button', { name: 'Gallery' }));
    await act(async () => {});

    // One photo per selection; two at once is refused without losing part 1.
    expect(mocks.gallery).toHaveBeenCalledWith(expect.objectContaining({ allowsMultipleSelection: false, selectionLimit: 1 }));
    expect(q.getByRole('alert')).toBeTruthy();
    expect(q.getByRole('button', { name: 'Review 1 part' })).toBeTruthy();
  });

  it('reopens a restored multi-part receipt in Batch to inspect, edit, or add parts', async () => {
    const first = createReceiptSection({ uri: 'file:///page-one.jpg', width: 1200, height: 2400 }, 'gallery');
    const second = createReceiptSection({ uri: 'file:///page-two.jpg', width: 1200, height: 2400 }, 'gallery');
    const alert = vi.spyOn(Alert, 'alert').mockImplementation(() => {});
    const done = vi.fn();
    const q = await screen({ initialSections: [first, second], onDone: done });
    try {
      expect(q.getByRole('tab', { name: 'Batch scan mode' }).props.accessibilityState.selected).toBe(true);
      await fireEvent.press(q.getByRole('button', { name: 'Review 2 parts' }));
      expect(q.getByRole('header', { name: 'Long receipt' })).toBeTruthy();
      expect(q.getByText('Part 2 of 2, top to bottom')).toBeTruthy();
      await fireEvent.press(q.getByRole('button', { name: 'Previous part' }));
      expect(q.getByText('1/2')).toBeTruthy();
      expect(q.getByRole('image', { name: 'Preview of part 1 of 2' }).props.source).toEqual({ uri: 'file:///page-one.jpg' });
      await fireEvent.press(q.getByRole('button', { name: 'Next part' }));
      expect(q.getByRole('image', { name: 'Preview of part 2 of 2' }).props.source).toEqual({ uri: 'file:///page-two.jpg' });
      expect(q.queryByRole('image', { name: 'Preview of part 1 of 2' })).toBeNull();

      await fireEvent.press(q.getByRole('button', { name: 'More actions' }));
      await fireEvent.press(q.getByRole('button', { name: 'Move part up' }));
      expect(q.getByText('1/2')).toBeTruthy();
      await fireEvent.press(q.getByRole('button', { name: 'Delete part' }));
      expect(alert).toHaveBeenCalledWith(
        'Delete part 1?',
        'This removes this part of the long receipt. The other parts stay.',
        expect.any(Array),
      );
      const remove = alert.mock.calls.at(-1)?.[2]?.find(button => button.text === 'Delete');
      await act(async () => remove?.onPress?.());
      expect(q.getByText('1/1')).toBeTruthy();
      expect(q.getByRole('image', { name: 'Preview of receipt' }).props.source).toEqual({ uri: 'file:///page-one.jpg' });
      await fireEvent.press(q.getByRole('button', { name: 'Finish receipt (1 part)' }));
      expect(done).toHaveBeenCalledWith([
        expect.objectContaining({ originalUri: 'file:///page-one.jpg' }),
      ]);
    } finally {
      alert.mockRestore();
    }
  });

  it('builds one long receipt from Batch parts with navigation, Add part and reordering', async () => {
    mocks.gallery
      .mockResolvedValueOnce({ canceled: false, assets: [{ uri: 'file:///a.png' }] })
      .mockResolvedValueOnce({ canceled: false, assets: [{ uri: 'file:///b.png' }] });
    const done = vi.fn();
    const q = await screen({ onDone: done });

    await fireEvent.press(q.getByRole('tab', { name: 'Batch scan mode' }));
    await fireEvent.press(q.getByRole('button', { name: 'Gallery' }));
    await act(async () => {});
    // A part waiting to be kept cannot be left for another slot.
    expect(q.queryByRole('button', { name: 'Add part' })).toBeNull();
    await fireEvent.press(q.getByRole('button', { name: 'Keep part' }));

    await fireEvent.press(q.getByRole('button', { name: 'Gallery' }));
    await act(async () => {});
    expect(q.getByText('2/2')).toBeTruthy();
    expect(q.getByRole('button', { name: 'Previous part' }).props.accessibilityState.disabled).toBe(true);
    await fireEvent.press(q.getByRole('button', { name: 'Keep part' }));
    await fireEvent.press(q.getByRole('button', { name: 'Review 2 parts' }));

    expect(q.getByRole('header', { name: 'Long receipt' })).toBeTruthy();
    expect(q.getByText('2/2')).toBeTruthy();

    // The last slot is the Add part card; the edit tools do not act on it.
    await fireEvent.press(q.getByRole('button', { name: 'Next part' }));
    expect(q.getByRole('button', { name: 'Retake' }).props.accessibilityState.disabled).toBe(true);
    await fireEvent.press(q.getByRole('button', { name: 'Add part' }));
    expect(q.getByRole('button', { name: 'Capture receipt' })).toBeTruthy();
    expect(q.getByRole('button', { name: 'Review 2 parts' })).toBeTruthy();
    await fireEvent.press(q.getByRole('button', { name: 'Review 2 parts' }));

    await fireEvent.press(q.getByRole('button', { name: 'More actions' }));
    await fireEvent.press(q.getByRole('button', { name: 'Move part up' }));
    expect(q.getByText('1/2')).toBeTruthy();

    await fireEvent.press(q.getByRole('button', { name: 'Finish receipt (2 parts)' }));
    const submitted = done.mock.calls[0]![0];
    expect(submitted.map((section: any) => section.originalUri)).toEqual([
      'file:///b.png-normalized.jpg',
      'file:///a.png-normalized.jpg',
    ]);
    expect(new Set(submitted.map((section: any) => section.receiptGroupId)).size).toBe(1);
  });

  it('keeps every Batch camera capture in one receipt group, in capture order', async () => {
    mocks.picture.mockReset();
    mocks.picture
      .mockResolvedValueOnce({ uri: 'file:///first.jpg', width: 1200, height: 2400 })
      .mockResolvedValueOnce({ uri: 'file:///second.jpg', width: 1200, height: 2400 });
    const done = vi.fn();
    const q = await screen({ onDone: done });

    await fireEvent.press(q.getByRole('tab', { name: 'Batch scan mode' }));
    await capture(q);
    await fireEvent.press(q.getByRole('button', { name: 'Keep part' }));
    await capture(q);
    expect(q.queryByRole('button', { name: /Finish receipt/ })).toBeNull();
    await fireEvent.press(q.getByRole('button', { name: 'Keep part' }));
    await fireEvent.press(q.getByRole('button', { name: 'Review 2 parts' }));
    await fireEvent.press(q.getByRole('button', { name: 'Finish receipt (2 parts)' }));

    const submitted = done.mock.calls[0]![0];
    expect(submitted.map((section: any) => section.originalUri)).toEqual([
      'file:///first.jpg',
      'file:///second.jpg',
    ]);
    expect(typeof submitted[0].receiptGroupId).toBe('string');
    expect(submitted[1].receiptGroupId).toBe(submitted[0].receiptGroupId);
  });

  it('finishes a kept long receipt from review exactly once', async () => {
    const done = vi.fn();
    const q = await screen({ onDone: done });

    await fireEvent.press(q.getByRole('tab', { name: 'Batch scan mode' }));
    await capture(q);
    expect(q.queryByRole('button', { name: /Finish receipt/ })).toBeNull();
    await fireEvent.press(q.getByRole('button', { name: 'Keep part' }));
    expect(q.getByRole('button', { name: 'Capture receipt' })).toBeTruthy();
    await fireEvent.press(q.getByRole('button', { name: 'Review 1 part' }));

    const finish = q.getByRole('button', { name: 'Finish receipt (1 part)' });
    await act(async () => {
      fireEvent.press(finish);
      fireEvent.press(finish);
    });
    expect(done).toHaveBeenCalledTimes(1);
    expect(done).toHaveBeenCalledWith([
      expect.objectContaining({ originalUri: 'file:///captured.jpg', receiptGroupId: expect.any(String) }),
    ]);
  });

  it('retakes one restored receipt in place without changing its group', async () => {
    const first = {
      ...createReceiptSection({ uri: 'file:///a.jpg', width: 1200, height: 2400 }, 'gallery'),
      receiptGroupId: 'receipt-a',
    };
    const second = {
      ...createReceiptSection({ uri: 'file:///b.jpg', width: 1200, height: 2400 }, 'gallery'),
      receiptGroupId: 'receipt-b',
    };
    const done = vi.fn();
    const q = await screen({ initialSections: [first, second], onDone: done });

    await fireEvent.press(q.getByRole('button', { name: 'Review 2 receipts' }));
    await fireEvent.press(q.getByRole('button', { name: 'Retake' }));
    await act(async () => {});
    await capture(q);
    expect(q.getByRole('button', { name: 'Keep part' })).toBeTruthy();
    expect(q.queryByRole('button', { name: 'Finish batch (2)' })).toBeNull();
    await fireEvent.press(q.getByRole('button', { name: 'Keep part' }));
    await fireEvent.press(q.getByRole('button', { name: 'Review 2 receipts' }));
    await fireEvent.press(q.getByRole('button', { name: 'Finish batch (2)' }));

    expect(done.mock.calls[0]![0]).toEqual([
      first,
      expect.objectContaining({
        localId: second.localId,
        originalUri: 'file:///captured.jpg',
        receiptGroupId: 'receipt-b',
      }),
    ]);
  });

  it('rotates only the selected page a quarter turn left', async () => {
    mocks.picture.mockReset();
    mocks.picture
      .mockResolvedValueOnce({ uri: 'file:///one.jpg', width: 1200, height: 2400 })
      .mockResolvedValueOnce({ uri: 'file:///two.jpg', width: 1200, height: 2400 });
    const done = vi.fn();
    const q = await screen({ onDone: done });

    await fireEvent.press(q.getByRole('tab', { name: 'Batch scan mode' }));
    await capture(q);
    await fireEvent.press(q.getByRole('button', { name: 'Keep part' }));
    await capture(q);
    await fireEvent.press(q.getByRole('button', { name: 'Left' }));
    await act(async () => {});
    expect(mocks.manipulate).toHaveBeenCalledWith('file:///two.jpg', [{ rotate: -90 }], expect.anything());
    await fireEvent.press(q.getByRole('button', { name: 'Keep part' }));
    await fireEvent.press(q.getByRole('button', { name: 'Review 2 parts' }));
    await fireEvent.press(q.getByRole('button', { name: 'Finish receipt (2 parts)' }));

    const submitted = done.mock.calls[0]![0];
    expect(submitted[0].processedUri).toBe('file:///one.jpg');
    expect(submitted[1].processedUri).toBe('file:///two.jpg-normalized.jpg');
  });

  it('shows a quality service failure without losing the captured receipt', async () => {
    mocks.upload.mockRejectedValue(new Error('Connection unavailable. Try again.'));
    const q = await screen();

    await capture(q);
    await fireEvent.press(q.getByRole('button', { name: 'More actions' }));
    await fireEvent.press(q.getByRole('button', { name: 'Check quality' }));
    await act(async () => {});

    expect(q.getByRole('alert')).toBeTruthy();
    expect(q.getByRole('button', { name: 'Use this receipt' })).toBeTruthy();
  });

  it('routes modal back through review and discard confirmation', async () => {
    const ref = createRef<any>();
    const cancel = vi.fn();
    const alert = vi.spyOn(Alert, 'alert').mockImplementation(() => {});
    try {
      const q = await screen({ ref, onCancel: cancel });
      await capture(q);

      await act(async () => ref.current.requestClose());
      expect(cancel).not.toHaveBeenCalled();
      await act(async () => ref.current.requestClose());
      expect(alert).toHaveBeenCalledWith('Discard this capture session?', expect.any(String), expect.any(Array));
    } finally {
      alert.mockRestore();
    }
  });

  it('aborts a pending quality request and ignores its late response', async () => {
    const ref = createRef<any>();
    let resolve!: (quality: any) => void;
    mocks.upload.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
    const q = await screen({ ref });

    await capture(q);
    await fireEvent.press(q.getByRole('button', { name: 'More actions' }));
    await fireEvent.press(q.getByRole('button', { name: 'Check quality' }));
    const signal = mocks.upload.mock.calls[0]![2] as AbortSignal;
    await act(async () => ref.current.requestClose());

    expect(signal.aborted).toBe(true);
    await fireEvent.press(q.getByRole('button', { name: 'More actions' }));
    await act(async () => resolve({ sharpness: 0, brightness: 0, tooBlurredToTrust: true }));
    expect(q.queryByText(/may be blurry/)).toBeNull();
    expect(q.getByRole('button', { name: 'Use this receipt' })).toBeTruthy();
  });
});
