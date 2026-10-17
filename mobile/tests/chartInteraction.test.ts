import { describe, expect, it } from 'vitest';
import { chartIndexAtX, donutIndexAtPoint } from '../src/lib/chartInteraction';

describe('Chart coordinate selection', () => {
  it('uses nearest points or equal bands in the measured viewport', () => {
    expect(chartIndexAtX(100, 400, 3)).toBe(1);
    expect(chartIndexAtX(100, 400, 3, 'bands')).toBe(0);
    expect(chartIndexAtX(150, 300, 3, 'bands')).toBe(1);
    expect(chartIndexAtX(300, 300, 3, 'bands')).toBe(2);
    expect(chartIndexAtX(-5, 300, 3)).toBe(0);
    expect(chartIndexAtX(450, 300, 3)).toBe(2);
  });

  it('rejects unavailable layout and supports one datum', () => {
    for (const [x, width, count] of [[0, 0, 3], [NaN, 300, 3], [1, Infinity, 3], [1, 300, 0]]) {
      expect(chartIndexAtX(x!, width!, count!)).toBeNull();
    }
    expect(chartIndexAtX(280, 300, 1)).toBe(0);
  });

  it('matches clockwise donut weights across a non-square viewport', () => {
    expect(donutIndexAtPoint({ x: 150, y: 5, width: 300, height: 100 }, [75, 25], .4)).toBe(0);
    expect(donutIndexAtPoint({ x: 35, y: 25, width: 300, height: 100 }, [75, 25], .4)).toBe(1);
    expect(donutIndexAtPoint({ x: 150, y: 50, width: 300, height: 100 }, [75, 25], .4)).toBeNull();
    expect(donutIndexAtPoint({ x: 301, y: 50, width: 300, height: 100 }, [75, 25], .4)).toBeNull();
  });

  it('does not allocate segments to zero, invalid or negative amounts', () => {
    const point = { x: 50, y: 5, width: 100, height: 100 };
    expect(donutIndexAtPoint(point, [0, NaN, -5, 10])).toBe(3);
    expect(donutIndexAtPoint(point, [0, -1])).toBeNull();
  });
});
