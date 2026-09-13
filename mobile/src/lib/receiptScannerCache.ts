/**
 * Loads the Android-only scanner bridge only when cleanup is requested.
 * Expo Go, iOS, and source-only test environments do not install that native
 * module; cleanup remains a safe no-op there.
 */
export async function deleteReceiptScannerFiles(uris: readonly (string | undefined)[]): Promise<number> {
  try {
    const scanner = await import("./customReceiptScanner");
    return await scanner.deleteCustomScannerFiles(uris);
  } catch {
    return 0;
  }
}

export async function clearReceiptScannerCache(): Promise<number> {
  try {
    const scanner = await import("./customReceiptScanner");
    return await scanner.clearCustomScannerCache();
  } catch {
    return 0;
  }
}
