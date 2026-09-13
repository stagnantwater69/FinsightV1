import { beforeEach, describe, expect, it, vi } from 'vitest';

const deleteCustomScannerFiles = vi.fn();
const clearCustomScannerCache = vi.fn();

vi.mock('../src/lib/customReceiptScanner', () => ({
  deleteCustomScannerFiles,
  clearCustomScannerCache,
}));

const scannerCache = await import('../src/lib/receiptScannerCache');

describe('receipt scanner cache boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('delegates exact scanner file URIs to the native bridge wrapper', async () => {
    deleteCustomScannerFiles.mockResolvedValueOnce(2);
    const uris = ['file:///cache/one-original.jpg', undefined, 'file:///cache/one-scan.jpg'];

    await expect(scannerCache.deleteReceiptScannerFiles(uris)).resolves.toBe(2);
    expect(deleteCustomScannerFiles).toHaveBeenCalledWith(uris);
  });

  it('clears native-owned receipt files at the account boundary', async () => {
    clearCustomScannerCache.mockResolvedValueOnce(4);

    await expect(scannerCache.clearReceiptScannerCache()).resolves.toBe(4);
    expect(clearCustomScannerCache).toHaveBeenCalledOnce();
  });

  it('keeps cleanup best-effort when the native bridge cannot load or rejects', async () => {
    deleteCustomScannerFiles.mockRejectedValueOnce(new Error('not linked'));
    clearCustomScannerCache.mockRejectedValueOnce(new Error('not linked'));

    await expect(scannerCache.deleteReceiptScannerFiles(['file:///cache/file.jpg'])).resolves.toBe(0);
    await expect(scannerCache.clearReceiptScannerCache()).resolves.toBe(0);
  });
});
