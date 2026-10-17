import React from 'react';
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import type { RecoveryMonthEndReview } from '../src/lib/types';
import { businessProfile } from './render/support/fixtures';

vi.mock('react-native', async () => {
  const { createRequire } = await import('node:module');
  return createRequire(import.meta.url)('react-native-web');
});
vi.mock('react-native-svg', async () => {
  const webElements = '../node_modules/react-native-svg/src/elements.web';
  return import(webElements);
});
vi.mock('@expo/vector-icons/Ionicons', () => ({ default: () => null }));
vi.mock('../src/components/ui', async () => {
  const { createRequire } = await import('node:module');
  const { Text, View } = createRequire(import.meta.url)('react-native-web');
  const { formatMoney } = await import('../src/lib/money');
  return {
    T: Text, Screen: View, Card: View, Disclosure: View, Callout: View,
    Money: ({ value, decimals }: { value: number; decimals?: boolean }) => React.createElement(Text, null, formatMoney(value, { decimals })),
  };
});
vi.mock('../src/components/ContentScrollView', async () => {
  const { createRequire } = await import('node:module');
  return { ContentScrollView: createRequire(import.meta.url)('react-native-web').View };
});
vi.mock('../src/components/ConnectionNotice', () => ({ ConnectionNotice: () => null, FreshnessStatus: () => null }));
vi.mock('../src/context/ThemeContext', async () => {
  const { lightPalette } = await import('../src/theme/palette');
  return { useTheme: () => lightPalette };
});
vi.mock('../src/context/BusinessProfileContext', () => ({ useBusinessProfiles: () => ({ selected: businessProfile }) }));
vi.mock('../src/context/ReportingPeriodContext', () => ({ useReportingPeriod: () => null }));
vi.mock('../src/lib/useInsight', () => ({
  useInsight: () => ({ data: review, loading: false, refreshing: false, rawError: null, lastUpdatedAt: 0, load: vi.fn() }),
}));

import { MonthEndReviewScreen } from '../src/screens/MonthEndReviewScreen';

const review: RecoveryMonthEndReview = {
  status: 'reviewable', month: '2026-09', coveragePercent: 92.4, surplusOrShortfall: -3800,
  monthlyExpenseBasis: {
    amount: 50000, source: 'owner_estimate', sourceMonth: null, ownerEstimate: 50000,
    recordsCompleteThroughMonth: null, recordsCompleteThroughConfirmedAt: null, eligibleRecordCount: 0,
  },
  strongestOpenDay: { date: '2026-09-14', sales: 5200 },
  weakestOpenDay: { date: '2026-09-02', sales: 400 },
  missingOrProvisionalDayCount: 3, openDayCount: 26, originalDailyTarget: 1900,
  finalAdjustedDailyTarget: 2100, baselineAppearsOffFromPattern: false,
  suggestedQuestionsForNextMonth: [], operatingScheduleConfigured: true,
};
const require = createRequire(import.meta.url);
const renderToStaticMarkup = require('react-dom/server').renderToStaticMarkup as (element: React.ReactNode) => string;

describe('Month-end SVG on the real web adapter', () => {
  it('keeps the decorative ring hidden while preserving its labelled financial result without DOM errors', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const html = renderToStaticMarkup(React.createElement(MonthEndReviewScreen, { navigation: { navigate: vi.fn() } }));
      const svg = html.match(/<svg\b[^>]*>/)?.[0];
      expect(svg).toContain('aria-hidden="true"');
      expect(svg).not.toMatch(/\baccessible=/);
      expect(html).toContain('Sales coverage for September 2026: 92.4% covered');
      expect(html).toContain('PHP 3,800.00');
      const ring = html.match(/<circle\b[^>]*stroke-dasharray[^>]*>/)?.[0];
      expect(ring).toContain('transform="rotate(-90 58 58)"');
      expect(ring).not.toMatch(/(?:transform-origin|origin|rotation)=/);
      expect(Number(ring?.match(/stroke-dashoffset="([^"]+)"/)?.[1])).toBeCloseTo(2 * Math.PI * 50 * (1 - 0.924), 10);
      expect(error).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      error.mockRestore();
      warn.mockRestore();
    }
  });
});
