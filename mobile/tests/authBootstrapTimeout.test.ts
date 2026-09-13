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

  it('passes the bootstrap abort signal to fetch', () => {
    expect(api).toMatch(/async function request<[\s\S]*?signal\?: AbortSignal;/);
    expect(api).toContain('signal: opts.signal');
  });
});
