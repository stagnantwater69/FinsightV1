import { statfsSync } from "node:fs";

// Native merging/stripping needs temporary copies in addition to the final APK.
// A minimum guard, not a guarantee for a cold or multi-architecture build.
export const MIN_ANDROID_BUILD_FREE_BYTES = 1024 ** 3;

/**
 * @param {string} projectDirectory
 * @param {(path: string) => { bavail: number | bigint, bsize: number | bigint }} readStats
 */
export function androidBuildSpaceError(projectDirectory, readStats = statfsSync) {
  let available;
  try {
    const stats = readStats(projectDirectory);
    available = Number(stats.bavail) * Number(stats.bsize);
    if (!Number.isFinite(available) || available < 0) throw new Error("Invalid filesystem capacity");
  } catch {
    return "Could not check free disk space for the Android build. Check the project drive before retrying.";
  }
  if (available >= MIN_ANDROID_BUILD_FREE_BYTES) return null;
  return `Not enough free disk space for the Android build (${(available / 1024 ** 3).toFixed(2)} GiB available; at least 1 GiB required). Free generated build artifacts or unused emulator data, then retry npm run android. Cold or multi-architecture builds may need several GiB. No files were deleted automatically.`;
}
