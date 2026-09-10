import { describe, expect, it } from 'vitest';
// Build scripts run directly in Node, outside the application's TypeScript graph.
import { androidBuildSpaceError, MIN_ANDROID_BUILD_FREE_BYTES } from '../scripts/android-build-space.mjs';

describe('Android build disk-space preflight', () => {
  const stats = (bytes: number) => () => ({ bavail: bytes, bsize: 1 });
  it('stops a full drive with an actionable message without deleting data', () => {
    expect(androidBuildSpaceError('/project', stats(48 * 1024 ** 2))).toMatch(/0.05 GiB available.*at least 1 GiB required/);
    expect(androidBuildSpaceError('/project', stats(0))).toContain('No files were deleted automatically');
  });
  it('allows the minimum and larger available capacity', () => {
    expect(androidBuildSpaceError('/project', stats(MIN_ANDROID_BUILD_FREE_BYTES))).toBeNull();
    expect(androidBuildSpaceError('/project', stats(4 * 1024 ** 3))).toBeNull();
  });
  it('uses space available to the current user, not reserved free blocks', () => {
    expect(androidBuildSpaceError('/project', () => ({ bavail: 0, bfree: 900000, bsize: 4096 }))).toContain('Not enough free disk space');
  });
  it('reports unavailable or invalid filesystem metrics', () => {
    expect(androidBuildSpaceError('/project', () => { throw new Error('filesystem unavailable'); })).toContain('Could not check');
    expect(androidBuildSpaceError('/project', stats(NaN))).toContain('Could not check');
  });
});
