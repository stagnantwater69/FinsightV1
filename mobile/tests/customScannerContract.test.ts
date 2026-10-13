import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ module: null as Record<string, unknown> | null, view: { name: 'NativeScannerView' } }));

vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));
vi.mock('expo-modules-core', () => ({
  requireNativeViewManager: vi.fn(() => state.view),
  requireOptionalNativeModule: vi.fn(() => state.module),
}));

async function load() {
  vi.resetModules();
  return import('../src/lib/customReceiptScanner');
}

describe('native scanner capture contract', () => {
  beforeEach(() => { state.module = null; });

  it('drives a native engine whose shutter never waits for receipt edges', async () => {
    state.module = { captureContract: 3 };
    const scanner = await load();
    expect(scanner.isCustomScannerOutdated()).toBe(false);
    expect(scanner.getCustomScannerView()).toBe(state.view);
  });

  it('falls back to the manual camera when the installed engine predates the contract', async () => {
    // A stale install: its shutter waited for all four edges and ignored the tap otherwise.
    state.module = { deleteCachedFiles: vi.fn() };
    const scanner = await load();
    expect(scanner.isCustomScannerOutdated()).toBe(true);
    expect(scanner.getCustomScannerView()).toBeNull();
  });

  it('reports nothing outdated when no native engine is linked', async () => {
    const scanner = await load();
    expect(scanner.isCustomScannerOutdated()).toBe(false);
    expect(scanner.getCustomScannerView()).toBeNull();
  });
});
