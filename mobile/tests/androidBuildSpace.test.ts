import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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

describe('standalone Android APK workflow', () => {
  const root = join(__dirname, '..');
  const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };
  const script = readFileSync(join(root, 'scripts', 'build-android-apk.mjs'), 'utf8');

  it('exposes a release build that embeds JavaScript instead of requiring Metro', () => {
    expect(packageJson.scripts['android:apk']).toBe('node scripts/build-android-apk.mjs');
    expect(script).toContain(':app:assembleRelease');
    expect(script).not.toContain('run:android');
    expect(script).toContain('"expo", "prebuild", "--platform", "android", "--no-install"');
  });

  it('targets the arm64 phone without exhausting the build host on four ABIs', () => {
    expect(script).toContain('"-PreactNativeArchitectures=arm64-v8a"');
    expect(script).toContain('"--no-parallel"');
    expect(script).toContain('"--max-workers=2"');
  });

  it('prints the exact APK path after a successful build', () => {
    expect(script).toContain('android/app/build/outputs/apk/release/app-release.apk');
  });

  it('shows and validates the API address that will be embedded in the phone APK', () => {
    expect(script).toContain('["expo", "config", "--type", "public", "--json"]');
    expect(script).toContain('Standalone APK API: ${apiBaseUrl}');
    expect(script).toContain('"localhost", "127.0.0.1", "0.0.0.0", "[::1]", "10.0.2.2"');
  });

});
