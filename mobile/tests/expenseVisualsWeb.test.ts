import React from 'react';
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import type { CategoryTrend } from '../src/lib/types';

vi.mock('react-native', async () => {
  const { createRequire } = await import('node:module');
  return createRequire(import.meta.url)('react-native-web');
});
vi.mock('react-native-svg', async () => {
  const webElements = '../node_modules/react-native-svg/src/elements.web';
  return import(webElements);
});
vi.mock('@expo/vector-icons/Ionicons', () => ({ default: () => null }));
vi.mock('../src/context/BusinessProfileContext', () => ({ useBusinessProfiles: () => undefined }));
vi.mock('../src/context/ReportingPeriodContext', () => ({ useReportingPeriod: () => null }));
vi.mock('../src/components/ui', async () => {
  const { createRequire } = await import('node:module');
  const { Text } = createRequire(import.meta.url)('react-native-web');
  return { T: Text };
});
vi.mock('../src/components/CoachKit', async () => {
  const { createRequire } = await import('node:module');
  const { Text, View } = createRequire(import.meta.url)('react-native-web');
  return {
    SectionTitle: ({ question, right }: { question: string; right: React.ReactNode }) =>
      React.createElement(View, null, React.createElement(Text, null, question), right),
    TealPanel: View,
  };
});
vi.mock('../src/context/ThemeContext', async () => {
  const { lightPalette } = await import('../src/theme/palette');
  return { useTheme: () => lightPalette };
});

import { CategoryBars } from '../src/components/ExpenseVisuals';

const require = createRequire(import.meta.url);
const renderToStaticMarkup = require('react-dom/server').renderToStaticMarkup as (element: React.ReactNode) => string;
const extractTransform = require('react-native-svg/lib/commonjs/lib/extract/extractTransform').default as (
  props: Record<string, unknown>,
) => number[];

const trends: CategoryTrend[] = [
  { categoryId: 10, categoryName: 'Stock', current: 500.5, previous: 400, change: 500.5 - 400, recordCount: 1, direction: 'up', percentChange: 25.125 },
  { categoryId: 11, categoryName: 'Utilities', current: 250.25, previous: 200, change: 250.25 - 200, recordCount: 1, direction: 'up', percentChange: 25.125 },
  { categoryId: 12, categoryName: 'Transport', current: 125.125, previous: 150, change: 125.125 - 150, recordCount: 1, direction: 'down', percentChange: -16.583 },
  { categoryId: 13, categoryName: 'Supplies', current: 75.075, previous: 50, change: 75.075 - 50, recordCount: 1, direction: 'up', percentChange: 50.15 },
  { categoryId: 14, categoryName: 'Repairs', current: 50.05, previous: 0, change: 50.05, recordCount: 1, direction: 'up', percentChange: null },
];

describe('Expense SVG web adapter', () => {
  it('renders category slices and Other through the real DOM adapter without invalid SVG properties', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const html = renderToStaticMarkup(React.createElement(CategoryBars, {
        trends, total: 1001, previousTotal: 800, comparedWith: 'September 2026', onOpen: vi.fn(),
      }));
      const circles = html.match(/<circle\b[^>]*>/g) ?? [];
      expect(circles).toHaveLength(5);
      const slices = circles.slice(1);
      for (const slice of slices) {
        expect(slice).toContain('transform="rotate(-90 56 56)"');
        expect(slice).not.toMatch(/(?:transform-origin|origin|rotation)=/);
        expect(slice).not.toMatch(/NaN|Infinity/);
      }
      const circumference = 2 * Math.PI * 44;
      let previous = 0;
      for (const [index, amount] of [500.5, 250.25, 125.125, 125.125].entries()) {
        const dash = slices[index]!.match(/stroke-dasharray="([^"]+)"/)![1]!.split(' ').map(Number);
        const offset = Number(slices[index]!.match(/stroke-dashoffset="([^"]+)"/)![1]);
        expect(dash[0]).toBeCloseTo(amount / 1001 * circumference, 10);
        expect(dash[1]).toBeCloseTo(circumference, 10);
        expect(offset).toBeCloseTo(-previous, 10);
        previous += dash[0]!;
      }
      expect(html).toContain('Stock, PHP 500.50, 50.0 percent');
      expect(html).toContain('Other, PHP 125.13, 12.5 percent');
      expect(error).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      error.mockRestore();
      warn.mockRestore();
    }
  });

  it.each([56, 58])('preserves native rotation geometry around center %i', (center) => {
    expect(extractTransform({ transform: `rotate(-90 ${center} ${center})` })).toEqual(
      extractTransform({ rotation: -90, origin: `${center}, ${center}` }),
    );
  });
});
