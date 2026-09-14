import { beforeEach, describe, expect, it, vi } from 'vitest';

const deleteCustomScannerFiles = vi.fn();
const clearCustomScannerCache = vi.fn();

vi.mock('../src/lib/customReceiptScanner', () => ({
  deleteCustomScannerFiles,
  clearCustomScannerCache,
}));

/**
 * A fake of the expo-file-system surface the helper touches: `Paths.cache`,
 * `Directory.exists`/`list`, `File.exists`/`delete`. Files live in `disk`.
 */
const CACHE = 'file:///data/app/cache/';
let disk: Set<string>;
let fileSystemBroken = false;
vi.mock('expo-file-system', () => {
  // Both native layers decode percent-escapes when resolving a file URI
  // (java.io.File(URI), URL.path), so `%2F` is a real separator by delete time.
  const nativePath = (uri: string) => {
    let decoded = uri;
    try {
      decoded = decodeURIComponent(uri);
    } catch {
      // Left as-is, like a URI the native parser rejects.
    }
    if (!decoded.startsWith('file://')) return decoded;
    const segments: string[] = [];
    for (const segment of decoded.slice('file://'.length).split('/')) {
      if (segment === '..') segments.pop();
      else if (segment !== '.') segments.push(segment);
    }
    return `file://${segments.join('/')}`;
  };
  class FakeFile {
    uri: string;
    constructor(...parts: (string | { uri: string })[]) {
      this.uri = nativePath(parts.map((part) => (typeof part === 'string' ? part : part.uri)).join(''));
    }
    get exists() { return disk.has(this.uri); }
    delete() {
      if (fileSystemBroken) throw new Error('EACCES');
      if (!disk.has(this.uri)) throw new Error('missing');
      disk.delete(this.uri);
    }
  }
  class FakeDirectory {
    uri: string;
    constructor(...parts: (string | { uri: string })[]) {
      const joined = parts.map((part) => (typeof part === 'string' ? part : part.uri)).join('');
      this.uri = joined.endsWith('/') ? joined : `${joined}/`;
    }
    get exists() { return [...disk].some((uri) => uri.startsWith(this.uri)); }
    list() {
      if (fileSystemBroken) throw new Error('EACCES');
      return [...disk].filter((uri) => uri.startsWith(this.uri) && !uri.slice(this.uri.length).includes('/')).map((uri) => new FakeFile(uri));
    }
  }
  return { File: FakeFile, Directory: FakeDirectory, Paths: { cache: new FakeDirectory(CACHE) } };
});

const scannerCache = await import('../src/lib/receiptScannerCache');

describe('receipt scanner cache boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fileSystemBroken = false;
    disk = new Set([
      `${CACHE}Camera/still.jpg`,
      `${CACHE}ImagePicker/pick.jpg`,
      `${CACHE}DocumentPicker/receipt.png`,
      `${CACHE}ImageManipulator/crop.jpg`,
      `${CACHE}ImageManipulator/rotate.jpg`,
      `${CACHE}receipt-scanner/uuid-scan.jpg`,
      `${CACHE}other/keep.txt`,
    ]);
    deleteCustomScannerFiles.mockResolvedValue(0);
    clearCustomScannerCache.mockResolvedValue(0);
  });

  it('delegates exact scanner file URIs to the native bridge wrapper', async () => {
    deleteCustomScannerFiles.mockResolvedValueOnce(2);
    const uris = ['file:///cache/one-original.jpg', undefined, 'file:///cache/one-scan.jpg'];

    await expect(scannerCache.deleteReceiptScannerFiles(uris)).resolves.toBe(2);
    expect(deleteCustomScannerFiles).toHaveBeenCalledWith(uris);
  });

  it('deletes the manual-camera, gallery, Files and manipulator copies a page points at', async () => {
    const uris = [
      `${CACHE}Camera/still.jpg`,
      `${CACHE}ImagePicker/pick.jpg`,
      `${CACHE}DocumentPicker/receipt.png`,
      `${CACHE}ImageManipulator/crop.jpg`,
      undefined,
      '',
    ];

    await expect(scannerCache.deleteReceiptScannerFiles(uris)).resolves.toBe(4);
    expect(disk.has(`${CACHE}Camera/still.jpg`)).toBe(false);
    expect(disk.has(`${CACHE}ImagePicker/pick.jpg`)).toBe(false);
    expect(disk.has(`${CACHE}DocumentPicker/receipt.png`)).toBe(false);
    expect(disk.has(`${CACHE}ImageManipulator/crop.jpg`)).toBe(false);
    expect(disk.has(`${CACHE}ImageManipulator/rotate.jpg`)).toBe(true);
  });

  it('never deletes outside the receipt cache folders, and ignores non-file URIs', async () => {
    disk.add(`${CACHE}ImagePicker/nested/deep.jpg`);
    const uris = [
      `${CACHE}other/keep.txt`,
      `${CACHE}ImagePicker/../other/keep.txt`,
      `${CACHE}ImagePicker/nested/deep.jpg`,
      'content://documents/receipt/123',
      'https://storage.test/receipt.jpg',
      '/data/app/cache/ImagePicker/pick.jpg',
    ];

    await expect(scannerCache.deleteReceiptScannerFiles(uris)).resolves.toBe(0);
    expect(disk.has(`${CACHE}other/keep.txt`)).toBe(true);
    expect(disk.has(`${CACHE}ImagePicker/pick.jpg`)).toBe(true);
    expect(disk.has(`${CACHE}ImagePicker/nested/deep.jpg`)).toBe(true);
  });

  it('rejects the cache folder itself, its parent, and an absolute path outside the cache', async () => {
    disk.add('file:///etc/hosts');
    const uris = [
      `${CACHE}ImagePicker/`,
      `${CACHE}ImagePicker`,
      CACHE,
      `${CACHE}ImagePicker/.`,
      `${CACHE}ImagePicker/..`,
      'file:///etc/hosts',
      'file:///data/app/cache/ImagePicker/pick.jpg'.replace('file:///', 'file://localhost/'),
    ];

    await expect(scannerCache.deleteReceiptScannerFiles(uris)).resolves.toBe(0);
    expect(disk.has('file:///etc/hosts')).toBe(true);
    expect(disk.has(`${CACHE}ImagePicker/pick.jpg`)).toBe(true);
  });

  it('treats a symlink-looking or dotfile name as an ordinary direct child and nothing more', async () => {
    disk.add(`${CACHE}Camera/.hidden.jpg`);
    disk.add(`${CACHE}Camera/link -> ..`);
    disk.add(`${CACHE}Camera/..still.jpg`);

    await expect(scannerCache.deleteReceiptScannerFiles([
      `${CACHE}Camera/.hidden.jpg`,
      `${CACHE}Camera/link -> ..`,
      `${CACHE}Camera/..still.jpg`,
    ])).resolves.toBe(3);
    expect([...disk].filter((uri) => uri.startsWith(`${CACHE}Camera/`))).toEqual([`${CACHE}Camera/still.jpg`]);
  });

  it('does not follow a percent-encoded dot-dot name past the folder', async () => {
    // Decodes to the folder above, where there is no file to delete.
    await expect(scannerCache.deleteReceiptScannerFiles([`${CACHE}ImagePicker/%2E%2E`])).resolves.toBe(0);
    expect(disk.size).toBe(7);
  });

  /*
   * Pinned defect (QA, 2026-09-14, owner mobile): ownedReceiptCopy only
   * refuses a literal `/` in the remainder. A percent-encoded separator
   * passes the guard and the native layer decodes it, so
   * `ImagePicker/..%2Fother%2Fkeep.txt` deletes `other/keep.txt`. Fix by
   * rejecting `%` (or decoding before the check) and flip this to `it`.
   */
  it('a percent-encoded separator in the name cannot reach outside the folder', async () => {
    await expect(scannerCache.deleteReceiptScannerFiles([
      `${CACHE}ImagePicker/..%2Fother%2Fkeep.txt`,
      `${CACHE}Camera/..%2fImageManipulator%2frotate.jpg`,
    ])).resolves.toBe(0);
    expect(disk.has(`${CACHE}other/keep.txt`)).toBe(true);
    expect(disk.has(`${CACHE}ImageManipulator/rotate.jpg`)).toBe(true);
  });

  it('clears native-owned receipt files at the account boundary', async () => {
    clearCustomScannerCache.mockResolvedValueOnce(4);

    await expect(scannerCache.clearReceiptScannerCache()).resolves.toBe(9);
    expect(clearCustomScannerCache).toHaveBeenCalledOnce();
  });

  it('clears every local receipt copy folder at the account boundary and leaves the rest of the cache alone', async () => {
    await scannerCache.clearReceiptScannerCache();

    expect([...disk]).toEqual([`${CACHE}receipt-scanner/uuid-scan.jpg`, `${CACHE}other/keep.txt`]);
  });

  it('keeps cleanup best-effort when the native bridge cannot load or rejects', async () => {
    deleteCustomScannerFiles.mockRejectedValueOnce(new Error('not linked'));
    clearCustomScannerCache.mockRejectedValueOnce(new Error('not linked'));
    fileSystemBroken = true;

    await expect(scannerCache.deleteReceiptScannerFiles([`${CACHE}Camera/still.jpg`])).resolves.toBe(0);
    await expect(scannerCache.clearReceiptScannerCache()).resolves.toBe(0);
  });
});
