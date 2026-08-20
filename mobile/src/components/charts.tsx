import { ReactNode } from "react";
import { View } from "react-native";
import Svg, { Circle, Defs, LinearGradient, Path, Rect, Stop } from "react-native-svg";
import { Money, T } from "./ui";
import { formatMoney } from "../lib/money";
import { brand, categorical, categoricalOnColor, font, ink, paper, space, status, statusText, typeScale } from "../theme/tokens";

/**
 * The chart kit.
 *
 * Built on react-native-svg rather than a charting library on purpose: every
 * chart here is a handful of rects and one path, and a library would bring a
 * bundle and an API surface far larger than the four shapes this app needs.
 *
 * THE RULES THESE FOLLOW, and they are not stylistic preferences:
 *
 *   - Categorical hues come from tokens.categorical in FIXED ORDER and are
 *     never cycled or reassigned. Colour follows the entity, not its rank, so
 *     filtering a category out must not repaint the survivors.
 *   - Data-ends are rounded 4px and anchored to the baseline; the zero end
 *     stays square so a bar cannot read as floating.
 *   - Adjacent fills are separated by a 2px surface-coloured gap rather than a
 *     border, so touching segments stay countable.
 *   - Grid and axes are recessive; the data is the only thing with weight.
 *   - Every series carries a visible text label. Three of the categorical hues
 *     sit below 3:1 against white, which is fine for a mark but means colour
 *     may never be the only thing telling two series apart.
 *   - Text wears ink tokens, never the series colour.
 *
 * Everything is also given an accessibilityLabel that states the numbers in
 * words, because a chart nobody can see is a chart that says nothing.
 */

/** Rounded only at the data end — the baseline end stays square. */
function barPath(x: number, y: number, w: number, h: number, r = 4, horizontal = false): string {
  const radius = Math.max(0, Math.min(r, horizontal ? w : h));
  if (horizontal) {
    return `M${x},${y} H${x + w - radius} A${radius},${radius} 0 0 1 ${x + w},${y + radius} V${y + h - radius} A${radius},${radius} 0 0 1 ${x + w - radius},${y + h} H${x} Z`;
  }
  return `M${x},${y + h} V${y + radius} A${radius},${radius} 0 0 1 ${x + radius},${y} H${x + w - radius} A${radius},${radius} 0 0 1 ${x + w},${y + radius} V${y + h} Z`;
}

/*
 * The shared shell every chart sits in: a title, an optional line of context,
 * then the marks.
 *
 * The title is declared a header so a screen reader can jump from chart to
 * chart. That matters more here than anywhere else in the app, because the
 * body of each chart is a single element carrying every number in it as one
 * long accessibilityLabel — without a header to jump to, reaching the next
 * chart means listening to the whole of the previous one.
 */
function ChartFrame({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  return (
    <View>
      <T accessibilityRole="header" variant="heading" style={{ marginBottom: subtitle ? 2 : space.md }}>
        {title}
      </T>
      {subtitle ? (
        <T variant="caption" style={{ marginBottom: space.md }}>
          {subtitle}
        </T>
      ) : null}
      {children}
    </View>
  );
}

// ============================================================
// Composition by category — ranked horizontal bars
// ============================================================
// A ranked bar, not a pie. The job is "which categories take the most, and by
// how much", and length on a common baseline is the one encoding people read
// accurately. A donut would make the top two hard to order and the small ones
// unreadable.

/** Tall enough to hold an 11px semibold percentage label without it overflowing the fill. */
const BAR_HEIGHT = 20;

export function CategoryBreakdown({
  data,
  title = "Where your money went",
  subtitle,
}: {
  data: { categoryId: number; categoryName: string; total: number }[];
  title?: string;
  subtitle?: string;
}) {
  const rows = [...data].sort((a, b) => b.total - a.total).slice(0, 8);
  const max = Math.max(...rows.map((r) => r.total), 1);
  const grandTotal = data.reduce((sum, r) => sum + r.total, 0);

  if (rows.length === 0) {
    return (
      <ChartFrame title={title}>
        <T variant="caption">Once you record an expense, this shows which categories use the most.</T>
      </ChartFrame>
    );
  }

  return (
    <ChartFrame title={title} subtitle={subtitle}>
      <View
        accessibilityLabel={`Spending by category. ${rows
          .map((r) => `${r.categoryName}, ${formatMoney(r.total)}`)
          .join(". ")}`}
      >
        {rows.map((row, i) => {
          const share = grandTotal > 0 ? (row.total / grandTotal) * 100 : 0;
          const fillPct = Math.max((row.total / max) * 100, 1.5);
          const swatch = categorical[i % categorical.length];
          const onSwatch = categoricalOnColor[i % categoricalOnColor.length];
          /*
           * Below this, the coloured fill itself is narrower than a "NN%"
           * label needs to sit inside it without spilling onto the empty
           * track behind it — three characters plus a percent sign, at the
           * label's own font size, against a bar that can be as little as a
           * sliver of the row's width. Short bars get their label just past
           * the fill's end instead, on the plain track rather than crammed
           * into colour that cannot hold it.
           */
          const fitsInsideFill = fillPct >= 16;
          return (
            <View key={row.categoryId} style={{ marginBottom: i === rows.length - 1 ? 0 : space.md }}>
              <View style={{ flexDirection: "row", justifyContent: "space-between", gap: space.sm }}>
                {/*
                  The name is the label AND the relief for the contrast warning
                  on three of these hues — identity is never colour alone.
                */}
                <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flex: 1 }}>
                  <View
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: 2,
                      backgroundColor: swatch,
                    }}
                  />
                  <T style={{ fontSize: typeScale.label, color: ink[800], flex: 1 }} numberOfLines={1}>
                    {row.categoryName}
                  </T>
                </View>
                <Money value={row.total} size={typeScale.label} color={ink[900]} weight="regular" />
              </View>

              {/*
                Thicker than a plain track bar needs to be on its own — 8px
                cannot hold even a small numeral without it overflowing top
                and bottom. BAR_HEIGHT exists to hold the percentage this
                board used to print in a separate column, now sitting inside
                the fill itself (or just past it, on short bars).
              */}
              <View style={{ height: BAR_HEIGHT, marginTop: 4 }}>
                {/*
                  A 0-100 viewBox stretched to the available width, so bar
                  lengths are a straight percentage and the track and the fill
                  share one coordinate system.
                */}
                <Svg
                  width="100%"
                  height={BAR_HEIGHT}
                  viewBox={`0 0 100 ${BAR_HEIGHT}`}
                  preserveAspectRatio="none"
                  style={{ position: "absolute", width: "100%", height: "100%" }}
                >
                  <Rect x={0} y={0} width={100} height={BAR_HEIGHT} rx={BAR_HEIGHT / 2} fill={paper[200]} />
                  <Path d={barPath(0, 0, fillPct, BAR_HEIGHT, BAR_HEIGHT / 2, true)} fill={swatch} />
                </Svg>
                {/*
                  An RN Text overlay, not SVG <Text> inside the chart above:
                  the viewBox's x and y units scale by different factors
                  (100 units of width vs BAR_HEIGHT units of height stretched
                  to the same physical box), so any font size specified in
                  those units would render visibly warped. A plain View
                  positioned by CSS percentage sits outside that distortion.
                */}
                <View
                  pointerEvents="none"
                  style={
                    fitsInsideFill
                      ? {
                          position: "absolute",
                          left: 0,
                          top: 0,
                          bottom: 0,
                          width: `${fillPct}%`,
                          alignItems: "center",
                          justifyContent: "center",
                        }
                      : {
                          position: "absolute",
                          left: `${fillPct}%`,
                          top: 0,
                          bottom: 0,
                          justifyContent: "center",
                          paddingLeft: space.xs,
                        }
                  }
                >
                  <T
                    style={{
                      fontSize: typeScale.micro,
                      fontFamily: font.sansSemibold,
                      // On the fill, this MUST be the paired on-colour, not an
                      // ink token — see tokens.ts on why a single fixed choice
                      // fails half the palette. Past the fill, it is back on
                      // the plain track, so an ordinary ink tone is fine.
                      color: fitsInsideFill ? onSwatch : ink[700],
                    }}
                  >
                    {share.toFixed(0)}%
                  </T>
                </View>
              </View>
            </View>
          );
        })}
      </View>
    </ChartFrame>
  );
}

// ============================================================
// Change over time — an area chart
// ============================================================
// Time is continuous, so the mark is continuous. A 2px line with a soft fill
// beneath it: the fill carries the shape at a glance, the line carries the
// precise value. Only the extremes are labelled — a number on every point is
// noise, not information.

/**
 * An axis tick: "48250" -> "48K".
 *
 * NO "PHP" PREFIX. It used to carry one on every tick, which cost four
 * characters on each of four labels in a gutter narrow enough that a
 * seven-figure business overflowed it — "PHP 1.2M" simply ran past its column
 * and collided with the plot. The currency is stated once, in the axis
 * caption, where it is read once rather than four times.
 *
 * The compaction is what keeps the width bounded regardless of the figures:
 * thousands and millions are folded, and a decimal appears only when dropping
 * it would round two different ticks to the same label.
 */
function axisTick(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value % 1_000_000 === 0 ? 0 : 1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value % 1_000 === 0 ? 0 : 1)}K`;
  return `${Math.round(value)}`;
}

/** The gutter the ticks are drawn in. Bounded because `axisTick` is. */
const AXIS_GUTTER = 34;

/**
 * Spending across the period, as a running total.
 *
 * CUMULATIVE, NOT PER-DAY, and that is a deliberate change of meaning rather
 * than a restyle. A per-day series answers "was Tuesday busy", which on a
 * sari-sari restock pattern is mostly noise — most days are near zero and the
 * two delivery days are spikes. A running total answers the question the
 * screen is actually headed by: how fast the month is being spent, and
 * whether the pace is steepening. It also ends exactly on the figure printed
 * above it, so the chart and the headline are visibly the same fact.
 *
 * The daily figures are not lost — they are what the curve is built from, and
 * the accessibility label still reports the busiest day.
 */
export function SpendTrend({
  data,
  title = "Spending so far",
  subtitle,
  height = 150,
}: {
  data: { date: string; total: number }[];
  title?: string;
  subtitle?: string;
  height?: number;
}) {
  if (data.length < 2) {
    return (
      <ChartFrame title={title}>
        <T variant="caption">A few more days of records and the trend will show here.</T>
      </ChartFrame>
    );
  }

  /*
   * The plot area is inset on the left for the value ticks. The SVG scales to
   * the card's width, so everything inside is expressed in this fixed
   * viewBox and the labels are drawn as real text OUTSIDE it — SVG text
   * inside a `preserveAspectRatio="none"` box would be stretched with it.
   */
  const W = 320;
  const H = height;
  const padY = 12;

  let running = 0;
  const series = data.map((d) => {
    running += d.total;
    return { date: d.date, daily: d.total, total: running };
  });

  const max = Math.max(...series.map((d) => d.total), 1);
  /*
   * Four gridlines at a rounded step, so the labels read as figures a person
   * would say ("20K", "40K") rather than as exact fractions of the maximum.
   */
  const step = niceStep(max / 3);
  const axisMax = Math.max(step * 3, max);
  const ticks = [3, 2, 1, 0].map((i) => step * i);

  const stepX = W / (series.length - 1);
  const y = (v: number) => padY + (1 - v / axisMax) * (H - padY * 2);

  const points = series.map((d, i) => ({ x: i * stepX, y: y(d.total), ...d }));
  const line = points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
  const area = `${line} L${W},${H} L0,${H} Z`;

  const peak = series.reduce((a, b) => (b.daily > a.daily ? b : a));
  const last = points[points.length - 1]!;

  return (
    <ChartFrame title={title} subtitle={subtitle}>
      <View
        accessibilityLabel={`Running total over ${series.length} days, reaching ${formatMoney(
          running,
        )}. The busiest single day was ${formatMoney(peak.daily)} on ${peak.date.slice(0, 10)}.`}
      >
        <View style={{ flexDirection: "row" }}>
          {/*
            Real text, laid out beside the chart rather than inside it. The
            SVG stretches to the card width with `preserveAspectRatio="none"`,
            which would squash any text drawn in the same coordinate space.
          */}
          <View
            style={{
              width: AXIS_GUTTER,
              height: H,
              justifyContent: "space-between",
              paddingVertical: padY - 6,
              paddingRight: 6,
            }}
          >
            {ticks.map((t) => (
              <T key={t} variant="caption" style={{ fontSize: typeScale.axis, textAlign: "right" }} numberOfLines={1}>
                {axisTick(t)}
              </T>
            ))}
          </View>

          <View style={{ flex: 1 }}>
            <Svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
              <Defs>
                <LinearGradient id="spendFill" x1="0" y1="0" x2="0" y2="1">
                  <Stop offset="0" stopColor={brand[500]} stopOpacity={0.20} />
                  <Stop offset="1" stopColor={brand[500]} stopOpacity={0.02} />
                </LinearGradient>
              </Defs>

              {/*
                Dashed gridlines at the same values the ticks name. Hairline
                and recessive: they exist so a point on the curve can be read
                against a figure, not to be looked at.
              */}
              {ticks.map((t) => (
                <Path
                  key={t}
                  d={`M0,${y(t).toFixed(1)} H${W}`}
                  stroke={t === 0 ? ink[200] : ink[100]}
                  strokeWidth={1}
                  strokeDasharray={t === 0 ? undefined : "3 4"}
                  vectorEffect="non-scaling-stroke"
                />
              ))}

              <Path d={area} fill="url(#spendFill)" />
              <Path
                d={line}
                stroke={brand[600]}
                strokeWidth={2}
                fill="none"
                strokeLinejoin="round"
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
              />
            </Svg>

            {/*
              The endpoint, drawn as a view rather than an SVG circle — the
              non-uniform scale above would render a circle as an ellipse.
              Positioned by percentage so it tracks the stretched geometry.
            */}
            <View
              pointerEvents="none"
              style={{
                position: "absolute",
                left: "100%",
                top: last.y,
                marginLeft: -9,
                marginTop: -5,
                width: 10,
                height: 10,
                borderRadius: 5,
                backgroundColor: brand[600],
                borderWidth: 2,
                borderColor: paper.DEFAULT,
              }}
            />

            <View style={{ flexDirection: "row", justifyContent: "space-between", marginTop: 6 }}>
              <T variant="caption" style={{ fontSize: typeScale.axis }}>{series[0]!.date.slice(5, 10)}</T>
              <T variant="caption" style={{ fontSize: typeScale.axis }}>
                {series[Math.floor(series.length / 2)]!.date.slice(5, 10)}
              </T>
              <T variant="caption" style={{ fontSize: typeScale.axis }}>
                {series[series.length - 1]!.date.slice(5, 10)}
              </T>
            </View>
          </View>
        </View>
      </View>
    </ChartFrame>
  );
}

/**
 * Rounds a raw step up to something a person would say out loud — 1, 2 or 5
 * times a power of ten. Axis labels of "16.7K" are arithmetically correct and
 * read as noise.
 */
function niceStep(raw: number): number {
  if (raw <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const normalised = raw / magnitude;
  const rounded = normalised <= 1 ? 1 : normalised <= 2 ? 2 : normalised <= 5 ? 5 : 10;
  return rounded * magnitude;
}

// ============================================================
// Money in vs money out — two lines, one baseline
// ============================================================
// Same construction as SpendTrend, but two series sharing one scale rather
// than one. Sales and expenses answer the single question owners open Home
// to ask — "am I bringing in more than I'm spending" — which a single-series
// chart can't show on its own.

const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-08-15" -> "Aug 15" for a daily axis tick; "2026-08" -> "Aug" for a monthly one. No Intl — Hermes' coverage of it is not guaranteed. */
function cashflowTick(date: string, granularity: "daily" | "monthly"): string {
  const month = MONTH_ABBR[Number(date.slice(5, 7)) - 1] ?? date;
  if (granularity === "monthly") return month;
  return `${month} ${Number(date.slice(8, 10))}`;
}

/** Rounds up to a "nice" ceiling — 1/2/5 times a power of ten — so the axis reads 0/5K/10K/15K/20K instead of the raw data max. */
function niceAxisMax(value: number): number {
  if (value <= 0) return 4;
  const magnitude = Math.pow(10, Math.floor(Math.log10(value)));
  const residual = value / magnitude;
  const niceResidual = residual <= 1 ? 1 : residual <= 2 ? 2 : residual <= 5 ? 5 : 10;
  return niceResidual * magnitude;
}

/** "5000" -> "5K". Below 1000, the raw number — matches the reference axis, which carries no currency sign (that's on the legend totals instead). */
function compactAxisLabel(value: number): string {
  if (value === 0) return "0";
  if (value < 1000) return String(Math.round(value));
  const thousands = value / 1000;
  return `${Number.isInteger(thousands) ? thousands : thousands.toFixed(1)}K`;
}

/**
 * Cashflow deliberately breaks the "grid and axes are recessive" house rule
 * above: gridlines, a labelled Y axis and a tick under every point, at the
 * owner's request, rather than the single trailing-edge label the other line
 * chart (SpendTrend) uses. Kept local to this one chart rather than promoted
 * into `ChartFrame` — nothing else here asked for it.
 */
export function CashflowChart({
  data,
  granularity = "daily",
  title = "Cashflow",
  subtitle,
  action,
  height = 200,
}: {
  data: { date: string; sales: number; expenses: number }[];
  granularity?: "daily" | "monthly";
  title?: string;
  subtitle?: string;
  action?: ReactNode;
  height?: number;
}) {
  const header = (
    <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.sm }}>
      <View style={{ flexDirection: "row", alignItems: "baseline", flexWrap: "wrap", flex: 1, gap: 6 }}>
        <T accessibilityRole="header" style={{ fontFamily: font.displayBold, fontSize: typeScale.title, color: ink[900] }}>
          {title}
        </T>
        {subtitle ? <T style={{ fontSize: typeScale.label, color: ink[500] }}>({subtitle})</T> : null}
      </View>
      {action}
    </View>
  );

  if (data.length < 2) {
    return (
      <View>
        {header}
        <T variant="caption" style={{ marginTop: space.sm }}>
          {granularity === "monthly"
            ? "A few more months of records and your cashflow trend will show here."
            : "A few more days of records and your cashflow trend will show here."}
        </T>
      </View>
    );
  }

  const W = 320;
  const H = height;
  const padY = 10;
  const AXIS_WIDTH = 34;
  const rawMax = Math.max(...data.flatMap((d) => [d.sales, d.expenses]));
  const axisMax = niceAxisMax(rawMax);
  const gridValues = [0, axisMax / 4, axisMax / 2, (axisMax * 3) / 4, axisMax];
  const stepX = W / (data.length - 1);
  const y = (v: number) => padY + (1 - v / axisMax) * (H - padY * 2);
  const path = (pick: (d: (typeof data)[number]) => number) =>
    data.map((d, i) => `${i === 0 ? "M" : "L"}${(i * stepX).toFixed(1)},${y(pick(d)).toFixed(1)}`).join(" ");

  const totalSales = data.reduce((s, d) => s + d.sales, 0);
  const totalExpenses = data.reduce((s, d) => s + d.expenses, 0);

  return (
    <View>
      {header}
      <View
        style={{ marginTop: space.md }}
        accessibilityLabel={`Cashflow over ${data.length} ${
          granularity === "monthly" ? "months" : "days"
        }. Total money in ${formatMoney(totalSales)}, total money out ${formatMoney(totalExpenses)}.`}
      >
        <View style={{ flexDirection: "row" }}>
          <View style={{ width: AXIS_WIDTH, height: H }}>
            {gridValues.map((v) => (
              <T key={v} style={{ position: "absolute", top: y(v) - 6, right: 6, fontSize: typeScale.axis, color: ink[400] }}>
                {compactAxisLabel(v)}
              </T>
            ))}
          </View>

          <View style={{ flex: 1 }}>
            <Svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
              {gridValues.map((v) => (
                <Path
                  key={v}
                  d={`M0,${y(v).toFixed(1)} H${W}`}
                  stroke={ink[100]}
                  strokeWidth={1}
                  strokeDasharray="3 4"
                  vectorEffect="non-scaling-stroke"
                />
              ))}
              {/* Expenses drawn first so the sales line, the one an owner wants to see win, sits on top. */}
              <Path
                d={path((d) => d.expenses)}
                stroke={status.serious}
                strokeWidth={2}
                fill="none"
                strokeLinejoin="round"
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
              />
              <Path
                d={path((d) => d.sales)}
                stroke={brand[600]}
                strokeWidth={2}
                fill="none"
                strokeLinejoin="round"
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
              />
            </Svg>

            {/* One tick per point, angled — the reference's diagonal date row. */}
            <View style={{ height: 30, marginTop: 4 }}>
              {data.map((d, i) => (
                <View key={d.date} style={{ position: "absolute", left: `${(i / (data.length - 1)) * 100}%`, top: 0 }}>
                  <T
                    numberOfLines={1}
                    style={{
                      width: 48,
                      fontSize: typeScale.axis,
                      color: ink[400],
                      transform: [{ translateX: -12 }, { rotate: "-40deg" }],
                    }}
                  >
                    {cashflowTick(d.date, granularity)}
                  </T>
                </View>
              ))}
            </View>
          </View>
        </View>

        {/* Two series, so a legend carrying the totals is mandatory, not optional. */}
        <View style={{ flexDirection: "row", justifyContent: "center", gap: space.xl, marginTop: space.sm }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
            <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: brand[600] }} />
            <View>
              <T variant="caption">Total Money In</T>
              <Money value={totalSales} size={17} weight="semibold" color={brand[600]} />
            </View>
          </View>
          <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
            <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: status.serious }} />
            <View>
              <T variant="caption">Total Money Out</T>
              <Money value={totalExpenses} size={17} weight="semibold" color={status.serious} />
            </View>
          </View>
        </View>
      </View>
    </View>
  );
}

// ============================================================
// Polarity — how each category moved
// ============================================================
// Up and down are opposite meanings, so this is the one place a two-hue
// diverging encoding is right. Neutral grey sits at no-change. Direction is
// also stated in words and by an arrow, never by colour alone.

export function CategoryChange({
  data,
  title = "How each category moved",
  subtitle,
}: {
  data: { categoryName: string; percentChange: number; direction: string }[];
  title?: string;
  subtitle?: string;
}) {
  if (data.length === 0) {
    return (
      <ChartFrame title={title}>
        <T variant="caption">Once there are two periods to compare, the change shows here.</T>
      </ChartFrame>
    );
  }

  const rows = data.slice(0, 6);
  const widest = Math.max(...rows.map((r) => Math.abs(r.percentChange)), 1);

  return (
    <ChartFrame title={title} subtitle={subtitle}>
      <View
        accessibilityLabel={rows
          .map((r) => `${r.categoryName} ${r.direction} ${Math.abs(r.percentChange).toFixed(0)} percent`)
          .join(". ")}
      >
        {rows.map((row, i) => {
          const up = row.percentChange > 0;
          const flat = Math.abs(row.percentChange) < 0.5;
          // Spending MORE is the unwelcome direction for an expense monitor,
          // so up is the warning pole and down the good one.
          const fill = flat ? ink[300] : up ? status.serious : status.good;
          const share = Math.abs(row.percentChange) / widest;

          return (
            <View key={row.categoryName} style={{ marginBottom: i === rows.length - 1 ? 0 : space.sm }}>
              <View style={{ flexDirection: "row", justifyContent: "space-between", gap: space.sm }}>
                <T style={{ fontSize: typeScale.label, color: ink[800], flex: 1 }} numberOfLines={1}>
                  {row.categoryName}
                </T>
                <T
                  style={{
                    fontSize: typeScale.label,
                    color: flat ? ink[500] : up ? statusText.serious : statusText.good,
                  }}
                >
                  {flat ? "no change" : `${up ? "↑" : "↓"} ${Math.abs(row.percentChange).toFixed(0)}%`}
                </T>
              </View>
              <View style={{ flexDirection: "row", alignItems: "center", marginTop: 4 }}>
                {/* Centre line is zero; bars grow left for down, right for up. */}
                <View style={{ flex: 1, alignItems: "flex-end" }}>
                  {!up && !flat ? (
                    <View style={{ height: 6, borderRadius: 3, width: `${share * 100}%`, backgroundColor: fill }} />
                  ) : null}
                </View>
                <View style={{ width: 1, height: 10, backgroundColor: ink[200] }} />
                <View style={{ flex: 1 }}>
                  {up && !flat ? (
                    <View style={{ height: 6, borderRadius: 3, width: `${share * 100}%`, backgroundColor: fill }} />
                  ) : null}
                </View>
              </View>
            </View>
          );
        })}
      </View>
    </ChartFrame>
  );
}

// ============================================================
// Magnitude against a target — columns with a reference line
// ============================================================

export function CoverageColumns({
  data,
  target,
  title = "Daily coverage",
  subtitle = "In PHP",
  height = 110,
}: {
  data: { date: string; amount: number }[];
  /** The line each day is trying to clear. */
  target: number;
  title?: string;
  subtitle?: string;
  height?: number;
}) {
  if (data.length === 0) {
    return (
      <ChartFrame title={title}>
        <T variant="caption">Record a sale and each day's progress shows here.</T>
      </ChartFrame>
    );
  }

  const rows = data.slice(-14);
  const W = 320;
  const H = height;
  const max = Math.max(...rows.map((r) => r.amount), target, 1);
  const gap = 2; // the 2px surface gap that keeps adjacent columns countable
  const slot = W / rows.length;
  const barW = Math.max(slot - gap, 2);
  const met = rows.filter((r) => r.amount >= target).length;

  /*
   * Four ticks at a rounded step, so the axis reads in figures a person would
   * say. The target rarely lands on one of them, which is the point — the
   * dashed line is what locates it, and the ticks are what make the columns
   * either side of it readable as amounts rather than as relative heights.
   */
  const step = niceStep(max / 3);
  /*
    ONE SCALE for the columns, the target line and the gridlines. Rounding the
    ticks up can push the top tick above the tallest column, and scaling the
    bars to `max` while labelling to `step * 3` would put every gridline
    slightly off the value it names — a chart that is wrong in the one way a
    chart must not be.
  */
  const axisMax = Math.max(step * 3, max);
  const axisTicks = [3, 2, 1, 0].map((i) => step * i);
  const targetY = (1 - target / axisMax) * H;

  return (
    <ChartFrame title={title} subtitle={subtitle}>
      {/*
        The target named once, at the top, in the same dash the line is drawn
        in. Without it the line is a mystery until the sentence under the
        chart is reached — and that sentence is a summary, not a legend.
      */}
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginBottom: space.sm }}>
        <View style={{ flex: 1 }} />
        <View style={{ width: 14, height: 0, borderTopWidth: 1.5, borderStyle: "dashed", borderTopColor: statusText.warning }} />
        <T variant="caption" style={{ fontSize: typeScale.axis }}>Target: {formatMoney(target)}</T>
      </View>

      <View
        accessibilityLabel={`Daily sales against a target of ${formatMoney(target)}. ${met} of ${
          rows.length
        } days met it.`}
        style={{ flexDirection: "row" }}
      >
        <View
          style={{ width: AXIS_GUTTER, height: H, justifyContent: "space-between", paddingRight: 6 }}
        >
          {axisTicks.map((t) => (
            <T
              key={t}
              variant="caption"
              style={{ fontSize: typeScale.axis, textAlign: "right", marginTop: -5 }}
              numberOfLines={1}
            >
              {axisTick(t)}
            </T>
          ))}
        </View>
        <View style={{ flex: 1 }}>
        <Svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
          {/* Gridlines under the columns, hairline and recessive. */}
          {axisTicks.map((t) => (
            <Path
              key={t}
              d={`M0,${((1 - t / axisMax) * H).toFixed(1)} H${W}`}
              stroke={t === 0 ? ink[200] : ink[100]}
              strokeWidth={1}
              strokeDasharray={t === 0 ? undefined : "3 4"}
              vectorEffect="non-scaling-stroke"
            />
          ))}
          {rows.map((row, i) => {
            const h = Math.max((row.amount / axisMax) * H, row.amount > 0 ? 2 : 0);
            return (
              <Path
                key={row.date}
                d={barPath(i * slot, H - h, barW, h, 4)}
                // Met or missed is a state, so it wears status colours — and
                // the count is written out above, so it is never colour alone.
                fill={row.amount >= target ? status.good : ink[200]}
              />
            );
          })}
          {/* The reference line sits ON TOP so it is never hidden by a column. */}
          <Path
            d={`M0,${targetY} H${W}`}
            stroke={statusText.warning}
            strokeWidth={1.5}
            strokeDasharray="4 3"
            vectorEffect="non-scaling-stroke"
          />
        </Svg>
        <View style={{ flexDirection: "row", justifyContent: "space-between", marginTop: 6 }}>
          <T variant="caption" style={{ fontSize: typeScale.axis }}>{rows[0]!.date.slice(5, 10)}</T>
          <T variant="caption" style={{ fontSize: typeScale.axis, color: ink[600] }}>
            {met} of {rows.length} days met it
          </T>
          <T variant="caption" style={{ fontSize: typeScale.axis }}>{rows[rows.length - 1]!.date.slice(5, 10)}</T>
        </View>
        </View>
      </View>
    </ChartFrame>
  );
}

// ============================================================
// Composition as a share of the whole — a donut
// ============================================================
// A donut answers a different question from the ranked bars above: not "which
// is biggest" but "how much of everything is this one". Both are on the
// dashboard because owners ask both.
//
// Capped at the top six with the remainder folded into a neutral "Other",
// which is the rule the categorical palette requires — a seventh slice is
// never a generated hue. Web caps at the same six with the same grey.

const DONUT_TOP_N = 6;
/** The remainder slice. Deliberately outside the categorical ramp. */
const OTHER_COLOR = "#8b9a9e";

const DONUT_RADIUS = 62;
const DONUT_STROKE = 22;

/**
 * The largest font size at which a total still fits inside the ring.
 *
 * Kept in step with the web donut, which had the same defect: a fixed size
 * chosen against short test amounts, which a real business's six- and
 * seven-figure totals then ran straight over. The figure face is monospaced,
 * so the width is predictable from the character count — roughly 0.6em each —
 * and the clear space is derived from the ring rather than hard-coded, so it
 * survives a change to either dimension. 12px comes off so the figure has
 * breathing room instead of touching the segments.
 */
function fitDonutLabel(label: string): number {
  const holeWidth = 2 * (DONUT_RADIUS - DONUT_STROKE / 2) - 12;
  return Math.max(10, Math.min(15, Math.floor(holeWidth / (label.length * 0.6))));
}

export function DonutChart({
  data,
  title = "Share of spending",
  subtitle,
}: {
  data: { categoryName: string; total: number }[];
  title?: string;
  subtitle?: string;
}) {
  const sorted = [...data].filter((d) => d.total > 0).sort((a, b) => b.total - a.total);

  if (sorted.length === 0) {
    return (
      <ChartFrame title={title}>
        <T variant="caption">Record an expense and its share of the total shows here.</T>
      </ChartFrame>
    );
  }

  const head = sorted.slice(0, DONUT_TOP_N);
  const tail = sorted.slice(DONUT_TOP_N);
  const slices = [
    ...head.map((d, i) => ({ name: d.categoryName, total: d.total, color: categorical[i] })),
    ...(tail.length > 0
      ? [{ name: `Other (${tail.length})`, total: tail.reduce((s, d) => s + d.total, 0), color: OTHER_COLOR }]
      : []),
  ];

  const total = slices.reduce((s, d) => s + d.total, 0);
  const SIZE = 168;
  // From the module constants, so the ring and the label that has to fit
  // inside it can never disagree about how big the hole is.
  const RADIUS = DONUT_RADIUS;
  const STROKE = DONUT_STROKE;
  const circumference = 2 * Math.PI * RADIUS;
  const centre = SIZE / 2;
  /* The 2px surface gap that keeps touching segments countable. */
  const GAP = 2;

  let offset = 0;

  return (
    <ChartFrame title={title} subtitle={subtitle}>
      <View
        style={{ flexDirection: "row", alignItems: "center", gap: space.lg }}
        accessibilityLabel={`Share of spending. ${slices
          .map((s) => `${s.name}, ${((s.total / total) * 100).toFixed(0)} percent`)
          .join(". ")}`}
      >
        <View style={{ width: SIZE, height: SIZE }}>
          <Svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`}>
            {slices.map((slice) => {
              const length = (slice.total / total) * circumference;
              const dash = Math.max(length - GAP, 0.5);
              const circle = (
                <Circle
                  key={slice.name}
                  cx={centre}
                  cy={centre}
                  r={RADIUS}
                  stroke={slice.color}
                  strokeWidth={STROKE}
                  fill="none"
                  strokeDasharray={`${dash} ${circumference - dash}`}
                  strokeDashoffset={-offset}
                  // Start at 12 o'clock rather than 3, which is where people
                  // expect a share to begin.
                  transform={`rotate(-90 ${centre} ${centre})`}
                />
              );
              offset += length;
              return circle;
            })}
          </Svg>
          {/*
            The hole is not decoration — it carries the total.

            The figure is sized to FIT that hole rather than set to a fixed
            15px, which only looked right because the amounts it was tried
            with were short. The face is monospaced, so the width a total
            needs is predictable: past about seven figures a fixed size runs
            straight over the ring.
          */}
          <View style={{ position: "absolute", inset: 0, alignItems: "center", justifyContent: "center" }}>
            <T variant="caption">Total</T>
            <Money value={total} size={fitDonutLabel(formatMoney(total))} weight="semibold" />
          </View>
        </View>

        {/* A legend is mandatory for more than one series. */}
        <View style={{ flex: 1, gap: 6 }}>
          {slices.map((slice) => (
            <View key={slice.name} style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              <View style={{ width: 8, height: 8, borderRadius: 2, backgroundColor: slice.color }} />
              <T style={{ flex: 1, fontSize: typeScale.caption, color: ink[700] }} numberOfLines={1}>
                {slice.name}
              </T>
              <T variant="caption" style={{ color: ink[600] }}>
                {((slice.total / total) * 100).toFixed(0)}%
              </T>
            </View>
          ))}
        </View>
      </View>
    </ChartFrame>
  );
}

// ============================================================
// This period against the last — paired bars
// ============================================================
// Two bars per category on ONE scale. Never two axes: the whole point is that
// the lengths are comparable, and a second scale would make them lie.

export function CategoryComparison({
  data,
  title = "This period vs last",
  subtitle,
  previousLabel = "Last period",
  currentLabel = "This period",
}: {
  data: { categoryName: string; current: number; previous: number; percentChange: number | null }[];
  title?: string;
  subtitle?: string;
  previousLabel?: string;
  currentLabel?: string;
}) {
  const rows = data.filter((r) => r.current > 0 || r.previous > 0).slice(0, 6);

  if (rows.length === 0) {
    return (
      <ChartFrame title={title}>
        <T variant="caption">Once there are two periods to compare, this fills in.</T>
      </ChartFrame>
    );
  }

  const max = Math.max(...rows.flatMap((r) => [r.current, r.previous]), 1);

  return (
    <ChartFrame title={title} subtitle={subtitle}>
      {/* Two series, so a legend is present rather than optional. */}
      <View style={{ flexDirection: "row", gap: space.md, marginBottom: space.md }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <View style={{ width: 8, height: 8, borderRadius: 2, backgroundColor: ink[300] }} />
          <T variant="caption">{previousLabel}</T>
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <View style={{ width: 8, height: 8, borderRadius: 2, backgroundColor: brand[600] }} />
          <T variant="caption">{currentLabel}</T>
        </View>
      </View>

      <View
        accessibilityLabel={rows
          .map(
            (r) =>
              `${r.categoryName}: ${formatMoney(r.previous)} then ${formatMoney(r.current)}`,
          )
          .join(". ")}
      >
        {rows.map((row, i) => (
          <View key={row.categoryName} style={{ marginBottom: i === rows.length - 1 ? 0 : space.md }}>
            <View style={{ flexDirection: "row", justifyContent: "space-between", gap: space.sm }}>
              <T style={{ fontSize: typeScale.label, color: ink[800], flex: 1 }} numberOfLines={1}>
                {row.categoryName}
              </T>
              {row.percentChange !== null ? (
                <T
                  style={{
                    fontSize: typeScale.caption,
                    color:
                      Math.abs(row.percentChange) < 0.5
                        ? ink[500]
                        : row.percentChange > 0
                          ? statusText.serious
                          : statusText.good,
                  }}
                >
                  {Math.abs(row.percentChange) < 0.5
                    ? "no change"
                    : `${row.percentChange > 0 ? "↑" : "↓"} ${Math.abs(row.percentChange).toFixed(0)}%`}
                </T>
              ) : (
                <T variant="caption">new</T>
              )}
            </View>

            {/* Previous sits above current, both from the same left baseline. */}
            <View style={{ marginTop: 4, gap: 3 }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
                <Svg width="100%" height={7} viewBox="0 0 100 7" preserveAspectRatio="none" style={{ flex: 1 }}>
                  <Path d={barPath(0, 0, Math.max((row.previous / max) * 100, 0.5), 7, 3.5, true)} fill={ink[300]} />
                </Svg>
                <Money
                  value={row.previous}
                  size={typeScale.caption}
                  color={ink[500]}
                  weight="regular"
                  style={{ width: 74, textAlign: "right" }}
                />
              </View>
              <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
                <Svg width="100%" height={7} viewBox="0 0 100 7" preserveAspectRatio="none" style={{ flex: 1 }}>
                  <Path d={barPath(0, 0, Math.max((row.current / max) * 100, 0.5), 7, 3.5, true)} fill={brand[600]} />
                </Svg>
                <Money
                  value={row.current}
                  size={typeScale.caption}
                  color={ink[800]}
                  weight="regular"
                  style={{ width: 74, textAlign: "right" }}
                />
              </View>
            </View>
          </View>
        ))}
      </View>
    </ChartFrame>
  );
}
