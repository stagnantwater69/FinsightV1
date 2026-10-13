import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const authContext = readFileSync(join(__dirname, '..', 'src', 'context', 'AuthContext.tsx'), 'utf8');
const api = readFileSync(join(__dirname, '..', 'src', 'lib', 'api.ts'), 'utf8');

describe('cold-start session restoration', () => {
  it('aborts the profile check instead of holding the launch screen forever', () => {
    expect(authContext).toContain('const BOOTSTRAP_PROFILE_TIMEOUT_MS = 10_000');
    expect(authContext).toContain('setTimeout(() => controller.abort(), BOOTSTRAP_PROFILE_TIMEOUT_MS)');
    expect(authContext).toContain('api.get<Profile>("/auth/me", undefined, controller.signal)');
    expect(authContext).toContain('clearTimeout(timeout)');
  });

  /*
   * The caller's signal now reaches fetch through the request timeout's
   * controller rather than directly. The behaviour that matters — an aborted
   * caller signal ending the request — is exercised in
   * tests/apiRequestTimeout.test.ts.
   */
  it('passes the bootstrap abort signal to fetch', () => {
    expect(api).toMatch(/async function request<[\s\S]*?signal\?: AbortSignal;/);
    expect(api).toContain('withTimeout(opts.signal, JSON_REQUEST_TIMEOUT_MS)');
    expect(api).toContain('signal: deadline.signal');
  });
});
