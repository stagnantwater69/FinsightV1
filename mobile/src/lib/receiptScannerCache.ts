/**
 * Every local copy of a receipt the app writes, and where it lands:
 *
 * - `receipt-scanner/`: the Android native scanner (owned and deleted by
 *   the Kotlin module; reached through the bridge wrapper).
 * - `Camera/`: expo-camera stills from the manual shutter.
 * - `ImagePicker/`: gallery picks, both on this screen and inside the camera.
 * - `DocumentPicker/`: "Choose a receipt from Files" copies (and CSV imports).
 * - `ImageManipulator/`: gallery JPEG normalisation, rotate, the crop written
 *   back from the server transform, and the analysis downscales.
 *
 * Both entry points are best-effort: a receipt that failed to leave the cache
 * must never block sign-out or a confirmed save.
 */
const RECEIPT_CACHE_FOLDERS = ["Camera", "ImagePicker", "DocumentPicker", "ImageManipulator"] as const;

type FileSystemModule = typeof import("expo-file-system");

function withTrailingSlash(uri: string): string {
  return uri.endsWith("/") ? uri : `${uri}/`;
}

function receiptCacheRoots(fs: FileSystemModule): string[] {
  return RECEIPT_CACHE_FOLDERS.map((folder) => withTrailingSlash(new fs.Directory(fs.Paths.cache, folder).uri));
}

/**
 * Only a direct child of one of the receipt cache folders qualifies. Both
 * native file layers decode percent-escapes before resolving the path, so a
 * `%2F` or `%2E` in the name is refused outright rather than reasoned about.
 */
function ownedReceiptCopy(uri: string, roots: readonly string[]): boolean {
  if (!uri.startsWith("file://")) return false;
  return roots.some((root) => {
    if (!uri.startsWith(root)) return false;
    const name = uri.slice(root.length);
    return (
      name.length > 0 &&
      !name.includes("/") &&
      !name.includes("\\") &&
      !name.includes("%") &&
      name !== "." &&
      name !== ".."
    );
  });
}

async function deleteLocalReceiptCopies(uris: readonly (string | undefined)[]): Promise<number> {
  try {
    const fs = await import("expo-file-system");
    const roots = receiptCacheRoots(fs);
    let deleted = 0;
    for (const uri of new Set(uris)) {
      if (!uri || !ownedReceiptCopy(uri, roots)) continue;
      try {
        const file = new fs.File(uri);
        if (!file.exists) continue;
        file.delete();
        deleted += 1;
      } catch {
        // Another page may still be deletable.
      }
    }
    return deleted;
  } catch {
    return 0;
  }
}

async function clearLocalReceiptCopies(): Promise<number> {
  try {
    const fs = await import("expo-file-system");
    let deleted = 0;
    for (const folder of RECEIPT_CACHE_FOLDERS) {
      try {
        const directory = new fs.Directory(fs.Paths.cache, folder);
        if (!directory.exists) continue;
        for (const entry of directory.list()) {
          try {
            entry.delete();
            deleted += 1;
          } catch {
            // Keep going; a locked file must not stop the rest of the sweep.
          }
        }
      } catch {
        // Same reasoning, one folder up.
      }
    }
    return deleted;
  } catch {
    return 0;
  }
}

/**
 * Loads the Android-only scanner bridge only when cleanup is requested.
 * Expo Go, iOS, and source-only test environments do not install that native
 * module; the native half stays a safe no-op there while the expo-file-system
 * half still runs.
 */
async function deleteNativeScannerFiles(uris: readonly (string | undefined)[]): Promise<number> {
  try {
    const scanner = await import("./customReceiptScanner");
    return await scanner.deleteCustomScannerFiles(uris);
  } catch {
    return 0;
  }
}

async function clearNativeScannerCache(): Promise<number> {
  try {
    const scanner = await import("./customReceiptScanner");
    return await scanner.clearCustomScannerCache();
  } catch {
    return 0;
  }
}

/** Deletes the given pages' local copies, whichever capture path wrote them. */
export async function deleteReceiptScannerFiles(uris: readonly (string | undefined)[]): Promise<number> {
  const [native, local] = await Promise.all([deleteNativeScannerFiles(uris), deleteLocalReceiptCopies(uris)]);
  return native + local;
}

/** Account boundary: sign-out, session end, account deletion. */
export async function clearReceiptScannerCache(): Promise<number> {
  const [native, local] = await Promise.all([clearNativeScannerCache(), clearLocalReceiptCopies()]);
  return native + local;
}
