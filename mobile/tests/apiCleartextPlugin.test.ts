import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { setApiCleartext } = require('../plugins/withApiCleartext.js');

function manifest(existing?: string) {
  return {
    manifest: {
      application: [{
        $: {
          'android:name': '.MainApplication',
          ...(existing === undefined ? {} : { 'android:usesCleartextTraffic': existing }),
        },
      }],
    },
  };
}

describe('API cleartext configuration plugin', () => {
  it('permits HTTP only when the configured API requires it', () => {
    expect(setApiCleartext(manifest(), true).manifest.application[0].$['android:usesCleartextTraffic']).toBe('true');
    expect(setApiCleartext(manifest('true'), false).manifest.application[0].$['android:usesCleartextTraffic']).toBe('false');
  });

  it('is registered in durable config with the API-scheme decision', () => {
    const config = readFileSync(new URL('../app.config.ts', import.meta.url), 'utf8');
    expect(config).toContain('new URL(apiBaseUrl).protocol === "http:"');
    expect(config).toContain('["./plugins/withApiCleartext", { enabled: apiUsesCleartext }]');
  });
});
