import { beforeEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({ deleteCachedFiles: vi.fn() }));

vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));
vi.mock('expo-modules-core', () => ({
  requireNativeViewManager: vi.fn(),
  requireOptionalNativeModule: vi.fn(() => native),
}));

const { deleteCustomScannerFiles } = await import('../src/lib/customReceiptScanner');

describe('custom scanner cache cleanup bridge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    native.deleteCachedFiles.mockImplementation(async (uris: string[]) => uris.length);
  });

  it('deduplicates, caps, and deletes scanner files in 32-item native chunks', async () => {
    const unique = Array.from({ length: 140 }, (_, index) => `file:///cache/${index}.jpg`);
    const requested = [undefined, '', unique[0], ...unique, unique[1]];

    await expect(deleteCustomScannerFiles(requested)).resolves.toBe(128);
    expect(native.deleteCachedFiles).toHaveBeenCalledTimes(4);
    expect(native.deleteCachedFiles.mock.calls.map(([chunk]) => chunk.length)).toEqual([32, 32, 32, 32]);
    expect(native.deleteCachedFiles.mock.calls.flatMap(([chunk]) => chunk)).toEqual(unique.slice(0, 128));
  });

  it('continues with later chunks when one native deletion rejects', async () => {
    const unique = Array.from({ length: 96 }, (_, index) => `file:///cache/${index}.jpg`);
    native.deleteCachedFiles
      .mockResolvedValueOnce(32)
      .mockRejectedValueOnce(new Error('native cleanup failed'))
      .mockResolvedValueOnce(30);

    await expect(deleteCustomScannerFiles(unique)).resolves.toBe(62);
    expect(native.deleteCachedFiles).toHaveBeenCalledTimes(3);
    expect(native.deleteCachedFiles.mock.calls[2]![0]).toEqual(unique.slice(64, 96));
  });

  it('does not call native cleanup for an empty request', async () => {
    await expect(deleteCustomScannerFiles([undefined, ''])).resolves.toBe(0);
    expect(native.deleteCachedFiles).not.toHaveBeenCalled();
  });
});
