import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { addFontScaleHandling } = require('../plugins/withScannerFontScale.js');

function manifest(changes?: string) {
  return {
    manifest: {
      application: [{
        $: { 'android:name': '.MainApplication' },
        activity: [
          { $: { 'android:name': '.MainActivity', ...(changes === undefined ? {} : { 'android:configChanges': changes }) } },
          { $: { 'android:name': '.OtherActivity', 'android:configChanges': 'orientation' } },
        ],
      }],
    },
  };
}

describe('scanner font-scale configuration plugin', () => {
  it('preserves existing flags and changes only MainActivity', () => {
    const result = addFontScaleHandling(manifest('orientation|screenSize|assetsPaths'));
    const activities = result.manifest.application[0].activity;
    expect(activities[0].$['android:configChanges']).toBe('orientation|screenSize|assetsPaths|fontScale');
    expect(activities[1].$['android:configChanges']).toBe('orientation');
  });

  it('is idempotent across repeated prebuilds', () => {
    const input = manifest('fontScale|orientation');
    expect(addFontScaleHandling(addFontScaleHandling(input))).toEqual(manifest('fontScale|orientation'));
  });

  it('handles a missing configChanges attribute', () => {
    expect(addFontScaleHandling(manifest()).manifest.application[0].activity[0].$['android:configChanges']).toBe('fontScale');
  });

  it('fails clearly instead of silently skipping a missing MainActivity', () => {
    expect(() => addFontScaleHandling({ manifest: { application: [{ activity: [] }] } })).toThrow();
  });

  it('is registered in durable Expo config', () => {
    expect(readFileSync(new URL('../app.config.ts', import.meta.url), 'utf8')).toContain('"./plugins/withScannerFontScale"');
  });
});
