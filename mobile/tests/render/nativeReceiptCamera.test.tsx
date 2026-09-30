import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, waitFor } from '@testing-library/react-native';

const launchReceiptScanner = vi.fn();
const nativeDocumentScanner = vi.fn();

vi.mock('../../src/lib/receiptScannerLaunch', () => ({ launchReceiptScanner }));
vi.mock('../../src/lib/nativeReceiptScanner', () => ({
  scanReceiptWithNativeDocumentScanner: nativeDocumentScanner,
}));
vi.mock('../../src/lib/receiptScannerFeature', () => ({
  ANDROID_RECEIPT_SCANNER_ENABLED: true,
}));

const { ThemeProvider } = await import('../../src/context/ThemeContext');
const { NativeReceiptCamera } = await import('../../src/components/receipt-camera/NativeReceiptCamera');

const section = (id: string) => ({
  localId: id,
  originalUri: `file:///${id}.jpg`,
  processedUri: `file:///${id}.jpg`,
  width: 600,
  height: 1000,
  quality: null,
  captureSource: 'native-document-scanner' as const,
});

const wrap = (node: React.ReactNode) => <ThemeProvider initialMode="dark">{node}</ThemeProvider>;

beforeEach(() => {
  launchReceiptScanner.mockReset();
  nativeDocumentScanner.mockReset();
});

describe('optional native receipt camera handoff', () => {
  it('shows a recoverable failure when the parent rejects the completed handoff', async () => {
    const pages = [section('page-1'), section('page-2')];
    launchReceiptScanner.mockResolvedValue({ kind: 'success', sections: pages });
    const onDone = vi.fn(() => {
      throw new Error('A batch can contain up to 8 receipts. Remove one receipt before continuing.');
    });
    const onCancel = vi.fn();

    const q = await render(wrap(
      <NativeReceiptCamera maxReceipts={1} onCancel={onCancel} onDone={onDone} />,
    ));

    await waitFor(() => expect(q.getByText(/up to 8 receipts/i)).toBeTruthy());
    expect(onDone).toHaveBeenCalledWith(pages);
    expect(q.getByRole('button', { name: 'Retry scanner' })).toBeEnabled();
    await fireEvent.press(q.getByRole('button', { name: 'Go back' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('treats all pages from the system scanner as one receipt', async () => {
    const pages = [section('page-1'), section('page-2'), section('page-3')];
    launchReceiptScanner.mockResolvedValue({ kind: 'success', sections: pages });
    const onDone = vi.fn();

    await render(wrap(
      <NativeReceiptCamera maxReceipts={1} onCancel={vi.fn()} onDone={onDone} />,
    ));

    await waitFor(() => expect(onDone).toHaveBeenCalledWith(pages));
    expect(launchReceiptScanner).toHaveBeenCalledWith([], nativeDocumentScanner, true);
  });

  it('reports exhausted receipt capacity without opening the system scanner', async () => {
    const onDone = vi.fn();
    const q = await render(wrap(
      <NativeReceiptCamera maxReceipts={0} onCancel={vi.fn()} onDone={onDone} />,
    ));

    await waitFor(() => expect(q.getByText(/no room for another receipt/i)).toBeTruthy());
    expect(launchReceiptScanner).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
  });
});
