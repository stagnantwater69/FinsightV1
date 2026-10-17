import React from 'react';
import { render } from '@testing-library/react-native';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/lib/api', () => ({ api: { get: vi.fn() } }));
vi.mock('../../src/context/AuthContext', () => ({ useAuth: () => ({ profile: null }) }));
const { useBusinessProfiles } = await import('../../src/context/BusinessProfileContext');
const { useReportingPeriod } = await import('../../src/context/ReportingPeriodContext');
function RequiredBusiness() { useBusinessProfiles(); return null; }
function RequiredPeriod() { useReportingPeriod(); return null; }

describe('Optional chart scopes preserve required provider contracts', () => {
  it('allows charts outside providers without starting provider work', async () => {
    let business: unknown = 'unset'; let period: unknown = 'unset';
    function Probe() { business = useBusinessProfiles(true); period = useReportingPeriod(true); return null; }
    await render(<Probe />);
    expect(business).toBeUndefined(); expect(period).toBeNull();
  });
  it.each(['business', 'period'])('still throws for a required %s provider', async (kind) => {
    const silence = vi.spyOn(console, 'error').mockImplementation(() => {});
    try { await expect(render(kind === 'business' ? <RequiredBusiness /> : <RequiredPeriod />)).rejects.toThrow(/Provider/); } finally { silence.mockRestore(); }
  });
});
