export function receiptScannerEnabledFor(
  platform: string,
  configured: unknown,
  runningInExpoGo = false,
): boolean {
  if (platform !== "android") return false;
  // Expo Go contains Expo's fixed native module set. A JavaScript dependency
  // can still be bundled there, but its Nitro implementation cannot exist;
  // offering Auto scan would therefore load the package and crash before the
  // fallback UI could recover. A custom development/EAS build is required.
  if (runningInExpoGo) return false;
  return configured !== false && configured !== "false";
}
