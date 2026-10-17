export interface ChartHitPoint {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function chartIndexAtX(x: number, width: number, count: number, mode: "points" | "bands" = "points"): number | null {
  if (!Number.isFinite(x) || !Number.isFinite(width) || width <= 0 || !Number.isInteger(count) || count < 1) return null;
  const position = Math.max(0, Math.min(1, x / width));
  return mode === "bands" ? Math.min(count - 1, Math.floor(position * count)) : Math.round(position * (count - 1));
}

/** Clockwise segments begin at noon, matching the chart kit's donut marks. */
export function donutIndexAtPoint(point: ChartHitPoint, values: readonly number[], innerRadius = 0, outerRadius = 1): number | null {
  if (point.width <= 0 || point.height <= 0) return null;
  const dx = (point.x - point.width / 2) / (point.width / 2);
  const dy = (point.y - point.height / 2) / (point.height / 2);
  const radius = Math.hypot(dx, dy);
  if (!Number.isFinite(radius) || radius < innerRadius || radius > outerRadius) return null;
  const total = values.reduce((sum, value) => sum + (Number.isFinite(value) && value > 0 ? value : 0), 0);
  if (total <= 0) return null;
  const fraction = ((Math.atan2(dy, dx) + Math.PI / 2 + Math.PI * 2) % (Math.PI * 2)) / (Math.PI * 2);
  let end = 0;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]!;
    if (!Number.isFinite(value) || value <= 0) continue;
    end += value / total;
    if (fraction < end) return index;
  }
  return values.findLastIndex((value) => Number.isFinite(value) && value > 0);
}
