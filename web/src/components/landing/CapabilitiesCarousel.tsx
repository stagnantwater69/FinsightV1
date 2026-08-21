import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  AlertTriangle,
  ArrowDownToLine,
  ArrowRight,
  BarChart3,
  Bot,
  Check,
  ChevronLeft,
  ChevronRight,
  FileSpreadsheet,
  Monitor,
  Scan,
  Smartphone,
  TrendingUp,
} from "lucide-react";
import { useMediaQuery } from "../../lib/hooks";

/**
 * The capabilities carousel — the seven things FinSight does, one card each.
 *
 * This replaces the bento grid that used to sit here. Same seven features in
 * the same order; what changed is that each one now gets a full card with a
 * drawn panel under it instead of a tile with a caption, which is only
 * affordable because they are no longer all on screen at once.
 *
 * THE PANELS ARE ILLUSTRATIONS AND SAY SO — the caption under the heading
 * states it, the same way ProductShowcase's does. See the note at the top of
 * pages/Landing.tsx for what got deleted from this page for inventing figures
 * and what the rule is now.
 *
 * Three claims in the mockup are not made here, because the codebase
 * contradicts them:
 *
 *   - "3.1 seconds · 0 manual edits" on the OCR card. A speed-and-accuracy
 *     measurement nobody took, on the feature whose real accuracy number
 *     (87%, tests/ocr-accuracy) is the reason the old statistics strip was
 *     deleted. The row now describes the review step, which is what the
 *     scanner actually does with values it is unsure about.
 *   - "Offline mode: records locally, syncs on signal", and a store tablet
 *     with two entries queued. FAQS in lib/marketingContent.ts answers "Can I
 *     use the app offline?" with "Not yet" — recording and scanning both need
 *     the server. A features section that contradicts the FAQ two screens
 *     down is worse than one that admits the limit.
 *   - "Real-Time Phone & Web Sync" as a title. There is no push channel;
 *     NotificationContext polls, and everything else loads on navigation.
 *     What is true is that both clients read the same records, which is what
 *     the title says now.
 */

/* ============================================================
   Panel primitives
   ============================================================
   Every card's illustration is built from the same four pieces, which is
   what keeps seven hand-drawn panels looking like one family rather than
   seven separate attempts at a dashboard.
*/

/** The bordered surface a panel is drawn on. */
function Panel({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`mt-5 flex flex-1 flex-col rounded-[14px] border border-paper-200 bg-paper-50 ${className}`}>
      {children}
    </div>
  );
}

/** A label/value line — the workhorse of every panel. */
function Row({
  label,
  value,
  valueClassName = "text-ink-900",
  valueStyle,
}: {
  label: ReactNode;
  value: ReactNode;
  valueClassName?: string;
  valueStyle?: CSSProperties;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-[11.5px] text-ink-400">{label}</span>
      <span className={`text-right text-[12.5px] font-bold tabular-nums ${valueClassName}`} style={valueStyle}>
        {value}
      </span>
    </div>
  );
}

/** The small uppercase heading that introduces a group inside a panel. */
function Caption({
  children,
  className = "text-ink-400",
  style,
}: {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <div className={`text-[11px] font-bold uppercase tracking-[0.12em] ${className}`} style={style}>
      {children}
    </div>
  );
}

interface Bar {
  /** Height as a percentage of the chart box. */
  h: number;
  /** Tailwind background class. Defaults to the muted step. */
  className?: string;
  /**
   * For the one bar whose colour comes from a CSS variable rather than a
   * class — the severity fill on the alerts card, which has to follow the
   * theme the same way a real flag does.
   */
  style?: CSSProperties;
}

/**
 * A mini bar chart.
 *
 * `h-full` on the column and a percentage height on the bar: the percentage
 * resolves against the parent, so without a parent that has a height every
 * bar computes to zero — the bug the old bento grid's chart shipped with.
 */
function MiniBars({ bars, height }: { bars: Bar[]; height: string }) {
  return (
    <div aria-hidden className="relative flex items-end gap-1.5" style={{ height }}>
      {bars.map((bar, i) => (
        <div
          key={i}
          className={`flex-1 rounded-[3px] ${bar.className ?? (bar.style ? "" : "bg-ink-200")}`}
          style={{ height: `${bar.h}%`, ...bar.style }}
        />
      ))}
    </div>
  );
}

/* ============================================================
   The seven panels
   ============================================================ */

/** Rows the scanner illustration shows as read off the photo. */
const RECEIPT_ITEMS = [
  { label: "Cooking Oil 2L (10 bottles)", amount: "₱1,850.00" },
  { label: "Refined Sugar 50kg bag", amount: "₱2,900.00" },
  { label: "Canned goods assorted (2 boxes)", amount: "₱1,340.00" },
];

function ReceiptPanel() {
  return (
    <Panel className="overflow-hidden">
      <div className="flex items-center justify-between gap-2.5 border-b border-paper-200 px-3.5 py-2.5">
        <span className="text-[11px] font-semibold text-ink-400">Receipt #9281 · Puregold</span>
        {/*
          Not "99.4% confidence". The scanner's own measured item extraction
          is 87% and it flags what it is unsure about — so the badge says the
          thing the reader has to do, which is check it. Same wording as the
          scanner panel in ProductShowcase, deliberately.
        */}
        <span className="flex shrink-0 items-center gap-1.5 text-[11px] font-bold text-tone-brand">
          <Check className="h-2.5 w-2.5 stroke-[3.2]" />
          Check before saving
        </span>
      </div>

      {RECEIPT_ITEMS.map((item) => (
        <div key={item.label} className="flex items-center justify-between gap-3 border-b border-paper-200/70 p-3.5">
          <span className="text-[12.5px] font-medium text-ink-900">{item.label}</span>
          <span className="shrink-0 text-[12.5px] font-bold tabular-nums text-ink-900">{item.amount}</span>
        </div>
      ))}

      <div className="flex items-center justify-between gap-3 border-b border-paper-200 bg-tint-brand px-3.5 py-3">
        <span className="text-xs font-bold tracking-[0.04em] text-ink-900">Total extracted</span>
        <span className="text-[13.5px] font-extrabold tabular-nums text-tone-brand">₱6,090.00</span>
      </div>

      <div className="space-y-2.5 px-3.5 py-3">
        <Row label="Category assigned" value="Inventory purchase" valueClassName="text-ink-900 font-semibold" />
        <Row label="Supplier matched" value="Puregold · 14th order" valueClassName="text-ink-900 font-semibold" />
        <Row label="Payment method read" value="Cash" valueClassName="text-ink-900 font-semibold" />
        <Row label="Anything unclear" value="Flagged for a one-tap fix" valueClassName="text-ink-900 font-semibold" />
      </div>

      {/*
        A SPAN, not a button — this is part of the drawing, and a real
        <button> here is a focus stop that takes a keyboard user's Enter and
        does nothing with it. Same call as the Confirm Record control in
        ProductShowcase.
      */}
      <div className="mt-auto flex items-center justify-between gap-2.5 bg-brand-900 px-3.5 py-3">
        <span className="text-[10.5px] font-bold tracking-[0.1em] text-brand-200">READY TO SAVE</span>
        <span className="flex shrink-0 items-center gap-1.5 text-[11.5px] font-bold text-white">
          Confirm record
          <ArrowRight className="h-3 w-3 stroke-[2.6]" />
        </span>
      </div>
    </Panel>
  );
}

/** Daily sales against the needed pace, over the last seven days. */
const PACE_BARS: Bar[] = [
  { h: 52 },
  { h: 74, className: "bg-brand-500" },
  { h: 45 },
  { h: 66, className: "bg-brand-500" },
  { h: 58 },
  { h: 100, className: "bg-brand-300" },
  { h: 71, className: "bg-brand-500" },
];

function RecoveryPanel() {
  return (
    <Panel className="gap-2.5 p-4">
      <div className="flex items-center justify-between gap-3">
        <span className="text-[11.5px] font-semibold tracking-[0.04em] text-ink-900">Monthly target</span>
        <span className="text-[11.5px] font-bold tabular-nums text-tone-brand">67% covered</span>
      </div>
      <div aria-hidden className="h-1.5 overflow-hidden rounded-full bg-ink-100">
        <div className="h-full w-[67%] rounded-full bg-gradient-to-r from-brand-600 to-brand-400" />
      </div>

      <div className="space-y-2.5 pt-1">
        <Row label="Today's needed pace" value="₱4,500/day" />
        <Row label="Fixed costs remaining" value="₱41,250" />
        <Row label="Booked this month" value="₱83,750 of ₱125,000" />
        <Row label="Days left in cycle" value="9 days" />
      </div>

      <div className="mt-1 border-t border-paper-200 pt-3.5">
        <div className="mb-2 flex items-center justify-between gap-2.5">
          <Caption>Daily sales vs. pace</Caption>
          <span className="text-[10.5px] text-ink-400">last 7 days</span>
        </div>
        <div className="relative">
          <MiniBars bars={PACE_BARS} height="70px" />
          {/* The needed-pace line the bars are read against. */}
          <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-[62%] border-t border-dashed border-ink-300" />
        </div>
        <div className="mt-2 flex items-center justify-between gap-2.5 text-[10.5px] text-ink-400">
          <span>Dashed line = ₱4,500 needed pace</span>
          <span className="shrink-0 font-bold text-tone-brand">4 of 7 above</span>
        </div>
      </div>

      {/*
        Amber, and only here.
        `accent` is reserved in tailwind.config.js for the Recovery Meter and
        for primary CTAs, and inside the meter it means one specific number:
        the ADJUSTED DAILY TARGET — what you have to do from here. That is
        exactly the number this box carries, so the illustration ends up
        showing the colour the real component wears.
      */}
      <div className="mt-auto rounded-[10px] border border-edge-accent bg-tint-accent px-3 py-2.5 text-[11.5px] leading-[1.5] text-ink-700">
        Hit <strong className="font-bold text-tone-accent">₱5,100/day</strong> for the next 3 days and you close the
        month on target.
      </div>
    </Panel>
  );
}

/**
 * The assistant exchange.
 *
 * Owner's question on the RIGHT, answer on the left — the mockup has it the
 * other way round, but ProductShowcase two sections up already draws the same
 * conversation with the question right-aligned, and one page cannot have the
 * assistant speaking from both sides.
 */
const CHAT: { from: "owner" | "finsight"; text: string }[] = [
  { from: "owner", text: "What was my best selling day this month?" },
  { from: "finsight", text: "Saturday, July 12 — ₱18,400 in sales." },
  { from: "owner", text: "And which supplier costs me most?" },
  { from: "finsight", text: "San Miguel — ₱26,900 this month, 31% of supplier spend." },
  { from: "owner", text: "Kaya pa ba ang ₱125,000 goal?" },
  { from: "finsight", text: "Yes — 67% covered with 9 days left. Keep ₱5,100/day." },
];

function AssistantPanel() {
  return (
    <div className="mt-5 flex flex-1 flex-col gap-2.5">
      {CHAT.map((line) => (
        <div
          key={line.text}
          className={
            line.from === "owner"
              ? "max-w-[94%] self-end rounded-[13px] rounded-br-[4px] bg-brand-900 px-3.5 py-2.5 text-[12.5px] font-medium leading-[1.45] text-white"
              : "max-w-[94%] self-start rounded-[13px] rounded-bl-[4px] border border-paper-200 bg-paper-50 px-3.5 py-2.5 text-[12.5px] leading-[1.45] text-ink-600"
          }
        >
          {line.text}
        </div>
      ))}

      {/*
        The composer, drawn rather than built: no input and no send handler,
        and hidden from screen readers, which would otherwise announce a text
        field that cannot be typed into.
      */}
      <div aria-hidden className="mt-auto flex items-center gap-2.5 rounded-full border border-paper-200 py-2 pl-3.5 pr-2">
        <span className="flex-1 text-[11.5px] text-ink-400">Ask in Tagalog or English…</span>
        <span className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-full bg-brand-900">
          <ArrowRight className="h-3 w-3 stroke-[2.6] text-white" />
        </span>
      </div>
      <p className="text-[10.5px] leading-[1.5] text-ink-400">
        Answers use only your own recorded sales and expenses.
      </p>
    </div>
  );
}

/** Flour price over the last six purchases; the latest one is the spike. */
const FLOUR_BARS = [56, 58, 55, 60, 59, 100];

function AlertsPanel() {
  /*
    The severity variables the Alert family uses (see components/Alert.tsx),
    not a literal amber. A pale wash under dark text has to become a deep wash
    under light text when the page goes dark, and these are the same three
    values a real "possible duplicate" flag is drawn with — so the
    illustration stays the flag the owner will actually see.
  */
  const wash: CSSProperties = {
    backgroundColor: "rgb(var(--sev-warning-bg))",
    borderColor: "rgb(var(--sev-warning-edge))",
    borderLeftColor: "rgb(var(--sev-warning-ink))",
  };
  const hairline: CSSProperties = { borderColor: "rgb(var(--sev-warning-edge))" };
  const ink: CSSProperties = { color: "rgb(var(--sev-warning-ink))" };

  return (
    <div
      className="mt-5 flex flex-1 flex-col gap-2.5 rounded-[6px_14px_14px_6px] border border-l-2 p-4"
      style={wash}
    >
      <Caption className="" style={ink}>
        Price spike flagged
      </Caption>
      <p className="text-[12.5px] leading-[1.5] text-ink-700">
        Flour purchase was 22% higher than your 30-day average.
      </p>

      <div className="space-y-2.5 border-t pt-3" style={hairline}>
        <Row label="30-day average" value="₱1,420 / sack" />
        <Row label="This purchase" value="₱1,732 / sack" valueClassName="" valueStyle={ink} />
        <Row label="Extra cost this month" value="₱2,496 (8 sacks)" />
      </div>

      <div className="mt-1 border-t pt-3.5" style={hairline}>
        <div className="mb-2">
          <Caption>Flour price, last 6 purchases</Caption>
        </div>
        <MiniBars
          bars={FLOUR_BARS.map((h, i) => ({
            h,
            // Only the latest purchase is the finding; the rest are context.
            style: i === FLOUR_BARS.length - 1 ? { backgroundColor: "rgb(var(--sev-warning-ink))" } : undefined,
          }))}
          height="64px"
        />
        <div className="mt-2 flex items-center justify-between gap-2.5 text-[10.5px] text-ink-400">
          <span>Mar – Jul steady</span>
          <span className="shrink-0 font-bold" style={ink}>
            Latest +22%
          </span>
        </div>
      </div>

      <div className="mt-auto border-t pt-3" style={hairline}>
        <div className="mb-2">
          <Caption>Also flagged this week</Caption>
        </div>
        <div className="space-y-2">
          {["Duplicate LPG entry, July 14", "Utilities up 14% vs. June"].map((flag) => (
            <div key={flag} className="flex items-center justify-between gap-3">
              <span className="text-[11.5px] text-ink-900">{flag}</span>
              <span className="shrink-0 text-[11.5px] font-bold" style={ink}>
                Review
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

const WEEK_BARS: Bar[] = [
  { h: 38 },
  { h: 60 },
  { h: 44 },
  { h: 88, className: "bg-brand-500" },
  { h: 70 },
  { h: 100, className: "bg-brand-300" },
  { h: 66 },
];

const WEEK_LABELS = ["M", "T", "W", "T", "F", "S", "S"];

/** Where the money goes — the four slices of the stacked bar, in order. */
const SPEND_SPLIT = [
  { label: "Inventory 46%", width: "46%", className: "bg-brand-900" },
  { label: "Wages 22%", width: "22%", className: "bg-brand-500" },
  { label: "Utilities 14%", width: "14%", className: "bg-brand-300" },
  { label: "Profit 18%", width: "18%", className: "bg-ink-200" },
];

function AnalyticsPanel() {
  return (
    <Panel className="gap-2.5 p-4">
      <MiniBars bars={WEEK_BARS} height="96px" />
      <div aria-hidden className="flex justify-between gap-1.5 text-[10px] font-semibold tracking-[0.04em] text-ink-400">
        {WEEK_LABELS.map((day, i) => (
          <span key={i} className="flex-1 text-center">
            {day}
          </span>
        ))}
      </div>

      <div className="space-y-2.5 border-t border-paper-200 pt-3">
        <Row label="Best day this week" value="Sat · ₱18,400" />
        <Row label="Week total" value="₱86,200" />
        <Row label="vs. last week" value="+11.3%" valueClassName="text-tone-brand" />
        <Row label="Cash on hand" value="₱24,880" />
        <Row label="Slowest hours" value="2 PM – 4 PM" />
      </div>

      <div className="mt-auto border-t border-paper-200 pt-3.5">
        <div className="mb-2.5">
          <Caption>Where the money goes</Caption>
        </div>
        <div aria-hidden className="flex h-3 overflow-hidden rounded-full bg-ink-100">
          {SPEND_SPLIT.map((slice) => (
            <div key={slice.label} className={slice.className} style={{ width: slice.width }} />
          ))}
        </div>
        <div className="mt-2.5 flex flex-wrap gap-x-3.5 gap-y-2 text-[10.5px] font-semibold text-ink-600">
          {SPEND_SPLIT.map((slice) => (
            <span key={slice.label} className="flex items-center gap-1.5">
              <span aria-hidden className={`h-[7px] w-[7px] rounded-[2px] ${slice.className}`} />
              {slice.label}
            </span>
          ))}
        </div>
      </div>
    </Panel>
  );
}

/** What the two clients are, and what each one can do. */
const CLIENTS = [
  { icon: Smartphone, label: "Android app", note: "Records, scanning, dashboard" },
  { icon: Monitor, label: "Web dashboard", note: "Everything, in any browser" },
];

/** Sample entries, phrased so the device each one came from is the point. */
const ACTIVITY = [
  { label: "Sale ₱1,240 · phone", when: "2 min ago" },
  { label: "Receipt scanned · phone", when: "18 min ago" },
  { label: "Monthly report opened · web", when: "1 hr ago" },
  { label: "Expense ₱860 edited · web", when: "3 hrs ago" },
];

function SyncPanel() {
  return (
    <div className="mt-5 flex flex-1 flex-col gap-2.5">
      {CLIENTS.map((client) => (
        <div
          key={client.label}
          className="flex items-center justify-between gap-3 rounded-xl border border-paper-200 bg-paper-50 px-3.5 py-2.5"
        >
          <span className="flex items-center gap-2.5 text-[12.5px] font-medium text-ink-900">
            <client.icon className="h-3.5 w-3.5 shrink-0 text-ink-400" />
            {client.label}
          </span>
          <span className="shrink-0 text-right text-[11px] text-ink-400">{client.note}</span>
        </div>
      ))}

      <div className="space-y-2.5 rounded-xl border border-paper-200 bg-paper-50 px-3.5 py-3">
        <Row label="Entries today" value="37 sales · 6 expenses" />
        <Row label="One account" value="Phone and browser together" valueClassName="text-ink-900" />
        {/*
          The limit, stated on the marketing page rather than discovered on a
          bus with no signal. FAQS answers this the same way — see
          lib/marketingContent.ts, "Can I use the app offline?".
        */}
        <Row label="Needs a connection" value="No offline recording yet" valueClassName="text-ink-500" />
      </div>

      <div className="mt-auto rounded-xl border border-paper-200 bg-paper-50 px-3.5 py-3">
        <div className="mb-2.5">
          <Caption>Recent activity</Caption>
        </div>
        <div className="space-y-2.5">
          {ACTIVITY.map((entry) => (
            <div key={entry.label} className="flex items-center justify-between gap-2.5">
              <span className="flex items-center gap-2 text-[11.5px] text-ink-900">
                <span aria-hidden className="h-[5px] w-[5px] shrink-0 rounded-full bg-brand-500" />
                {entry.label}
              </span>
              <span className="shrink-0 text-[11px] text-ink-400">{entry.when}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

const EXPORT_FILES = ["finsight_sales_july.csv", "finsight_expenses_july.xlsx"];

function ExportPanel() {
  return (
    <div className="mt-5 flex flex-1 flex-col gap-2.5">
      {EXPORT_FILES.map((file) => (
        <div
          key={file}
          className="flex items-center justify-between gap-3 rounded-xl border border-paper-200 bg-paper-50 px-3.5 py-3"
        >
          <span className="min-w-0 truncate font-mono text-xs font-medium text-ink-900">{file}</span>
          <ArrowDownToLine className="h-3.5 w-3.5 shrink-0 stroke-[2.4] text-brand-600" />
        </div>
      ))}

      <div className="space-y-2.5 rounded-xl border border-paper-200 bg-paper-50 px-3.5 py-3">
        <Row label="Columns included" value="Date · Item · Category · Total" />
        <Row label="Rows in this export" value="1,248 entries" />
        <Row label="Range" value="Any month, quarter, or custom dates" />
      </div>

      <p className="mt-auto text-[10.5px] leading-[1.5] text-ink-400">
        Plain spreadsheet files, ready to hand to your accountant.
      </p>
    </div>
  );
}

/* ============================================================
   The cards
   ============================================================ */

interface Feature {
  id: string;
  eyebrow: string;
  icon: React.ElementType;
  title: string;
  body: string;
  panel: ReactNode;
}

const FEATURES: Feature[] = [
  {
    id: "ocr",
    eyebrow: "Signature",
    icon: Scan,
    title: "Instant Receipt OCR & Snap Recording",
    body: "Never waste time typing long supplier receipts. Point your phone camera, snap a photo, and watch FinSight parse items, dates, and amounts into organized expense records.",
    panel: <ReceiptPanel />,
  },
  {
    id: "recovery",
    eyebrow: "Targets",
    icon: TrendingUp,
    title: "Dynamic Recovery Meter",
    body: "Know the exact daily sales target needed to cover rent, wages, and utilities — recalculated every time you record a sale or an expense.",
    panel: <RecoveryPanel />,
  },
  {
    id: "assistant",
    eyebrow: "Assistant",
    icon: Bot,
    title: "Natural Language AI Assistant",
    body: "Ask in Tagalog or English, the way you would ask a business partner. Answers come only from your own recorded sales and expenses.",
    panel: <AssistantPanel />,
  },
  {
    id: "alerts",
    eyebrow: "Alerts",
    icon: AlertTriangle,
    title: "Expense & Overcharge Alerts",
    body: "FinSight watches your usual prices and flags overcharges, duplicates, and creeping costs before they quietly drain your profit.",
    panel: <AlertsPanel />,
  },
  {
    id: "analytics",
    eyebrow: "Analytics",
    icon: BarChart3,
    title: "Sales & Cash Flow Analytics",
    body: "Simple charts show which days, hours, and products actually make money — no spreadsheet formulas to maintain.",
    panel: <AnalyticsPanel />,
  },
  {
    id: "sync",
    eyebrow: "Sync",
    icon: Smartphone,
    title: "Phone and Web, One Set of Records",
    body: "Log sales on your phone behind the counter, then open the same month on your laptop at home. One account, one set of records, whichever you happen to be holding.",
    panel: <SyncPanel />,
  },
  {
    id: "export",
    eyebrow: "Export",
    icon: FileSpreadsheet,
    title: "One-Click Excel / CSV Export",
    body: "Export clean, formatted spreadsheets any time — ready for your accountant, your lender, or your tax filing.",
    panel: <ExportPanel />,
  },
];

function FeatureCard({ feature }: { feature: Feature }) {
  return (
    <article className="group relative flex h-full min-h-[600px] flex-col overflow-hidden rounded-[20px] border border-paper-200 bg-gradient-to-br from-paper via-paper to-paper-50 p-[26px] shadow-[0_10px_30px_rgba(6,35,28,0.06)] transition duration-500 hover:-translate-y-1 hover:border-brand-300 hover:shadow-lg">
      <div
        aria-hidden
        className="pointer-events-none absolute -right-16 -top-20 h-[280px] w-[280px] rounded-full opacity-90 blur-[18px] transition-transform duration-700 ease-out group-hover:scale-110"
        style={{
          background:
            "radial-gradient(circle at 36% 38%, rgb(var(--tone-brand) / 0.26) 0%, rgb(var(--tone-brand) / 0.10) 48%, rgb(var(--tone-brand) / 0) 74%)",
        }}
      />

      <div className="relative flex flex-1 flex-col">
        <div className="flex items-center gap-2.5">
          <span className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-[9px] border border-edge-brand bg-tint-brand">
            <feature.icon className="h-[15px] w-[15px] text-brand-600" />
          </span>
          <span className="text-[10.5px] font-bold uppercase tracking-[0.18em] text-ink-400">{feature.eyebrow}</span>
        </div>

        <h3 className="mt-[22px] font-display text-[22px] font-bold leading-[1.22] tracking-[-0.025em] text-ink-900">
          {feature.title}
        </h3>
        <p className="mt-3 text-sm leading-[1.6] text-ink-600">{feature.body}</p>

        {feature.panel}
      </div>
    </article>
  );
}

/* ============================================================
   The carousel
   ============================================================ */

function ArrowButton({
  direction,
  onClick,
  className = "",
}: {
  direction: "prev" | "next";
  onClick: () => void;
  className?: string;
}) {
  const Icon = direction === "prev" ? ChevronLeft : ChevronRight;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={direction === "prev" ? "Previous features" : "Next features"}
      className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-full border border-paper-200 bg-paper text-ink-900 shadow-md transition duration-250 hover:border-brand-900 hover:bg-brand-900 hover:text-white ${className}`}
    >
      <Icon className="h-[18px] w-[18px] stroke-[2.2]" />
    </button>
  );
}

/**
 * How many cards there are, once. The track renders the list TWICE — see the
 * loop note in the component.
 */
const CARD_COUNT = FEATURES.length;

/** Milliseconds of no scroll events that count as "the scroll has stopped". */
const SETTLE_MS = 140;

export function CapabilitiesCarousel() {
  /*
    A SCROLLER, not a transform track.

    The mockup slides a flex row and reorders the cards with CSS `order` to
    fake an infinite loop. That works on a fixed 1320px canvas and fails on a
    phone twice over: the visual order stops matching the DOM order, which is
    what a screen reader and the tab sequence follow, and there is no swipe —
    on the one device most of these owners actually have. Native scroll-snap
    gives both back for free.

    THE LOOP ONLY EVER MOVES FORWARD.

    The list is rendered twice, so card 6 is followed by a second copy of
    cards 0, 1, 2 and Next never runs out of track to slide onto. Once the
    scroll has come to rest past the end of the first copy, scrollLeft is
    moved back by one full copy with no animation: the two positions show
    pixel-identical content, so the jump is invisible, and the next press of
    Next slides forward again from what is now the start.

    The rewind has to wait for the scroll to STOP. Moving scrollLeft while a
    smooth scroll is in flight leaves the browser animating toward an absolute
    position that no longer means what it meant when the animation started,
    which lands the strip a card off.
  */
  const viewportRef = useRef<HTMLDivElement>(null);
  /** Card index in the doubled track, 0 .. 2×CARD_COUNT-1. */
  const [index, setIndex] = useState(0);
  const reduceMotion = useMediaQuery("(prefers-reduced-motion: reduce)");

  /**
   * Card pitch, and the furthest card the scroller can actually come to rest
   * on. Measured rather than computed: the card width is a `calc()` that
   * changes at two breakpoints, and the scroller's own padding is in it too.
   */
  const metrics = useCallback(() => {
    const track = viewportRef.current;
    const cards = track?.children;
    if (!track || !cards || cards.length < 2) return null;
    const step = (cards[1] as HTMLElement).offsetLeft - (cards[0] as HTMLElement).offsetLeft;
    if (step <= 0) return null;
    return { step, maxCard: Math.floor((track.scrollWidth - track.clientWidth) / step) };
  }, []);

  /**
   * Where the strip is right now, read from the DOM rather than from state.
   *
   * A swipe never goes through a handler, so state can be a frame behind at
   * the moment an arrow is pressed — and a Next computed from a stale index
   * moves the strip backwards, which is the one thing it must never do.
   */
  const currentCard = useCallback(() => {
    const track = viewportRef.current;
    const m = metrics();
    if (!track || !m) return 0;
    return Math.round(track.scrollLeft / m.step);
  }, [metrics]);

  const scrollToCard = useCallback(
    (card: number) => {
      const track = viewportRef.current;
      const m = metrics();
      if (!track || !m) return;
      track.scrollTo({ left: card * m.step, behavior: reduceMotion ? "auto" : "smooth" });
    },
    [metrics, reduceMotion],
  );

  const next = () => scrollToCard(currentCard() + 1);

  const prev = () => {
    const track = viewportRef.current;
    const m = metrics();
    if (!track || !m) return;
    const card = currentCard();
    if (card > 0) {
      scrollToCard(card - 1);
      return;
    }
    /*
      Standing on the first card, with nothing to its left. Hop onto its copy
      one list further along — the same pixels, so nothing appears to happen —
      and slide back from there, so Previous is a leftward slide rather than a
      jump to the far end.
    */
    track.scrollTo({ left: CARD_COUNT * m.step, behavior: "auto" });
    requestAnimationFrame(() => scrollToCard(CARD_COUNT - 1));
  };

  /** A dot: go to that feature, forwards where the track allows it. */
  const goToFeature = (feature: number) => {
    const m = metrics();
    if (!m) return;
    const card = currentCard();
    const forward = card + ((feature - (card % CARD_COUNT) + CARD_COUNT) % CARD_COUNT);
    scrollToCard(forward <= m.maxCard ? forward : feature);
  };

  /*
    The scroll position is the source of truth for which dot is active — a
    swipe has to move the dots too, and it never goes through our handlers.
    Read inside rAF so a fling does not re-render on every scroll event; the
    rewind runs off a timer instead, once the events stop arriving.
  */
  useEffect(() => {
    const track = viewportRef.current;
    if (!track) return;
    let frame = 0;
    let settle: number | undefined;

    const onScroll = () => {
      if (!frame) {
        frame = requestAnimationFrame(() => {
          frame = 0;
          const m = metrics();
          if (m) setIndex(Math.round(track.scrollLeft / m.step));
        });
      }
      window.clearTimeout(settle);
      settle = window.setTimeout(() => {
        const m = metrics();
        if (!m) return;
        const card = Math.round(track.scrollLeft / m.step);
        // Past the end of the first copy: rewind by one copy, invisibly.
        if (card >= CARD_COUNT) track.scrollTo({ left: (card - CARD_COUNT) * m.step, behavior: "auto" });
      }, SETTLE_MS);
    };

    track.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      track.removeEventListener("scroll", onScroll);
      if (frame) cancelAnimationFrame(frame);
      window.clearTimeout(settle);
    };
  }, [metrics]);

  const active = ((index % CARD_COUNT) + CARD_COUNT) % CARD_COUNT;

  return (
    <section id="features" className="relative scroll-mt-24 overflow-hidden border-t border-paper-200/80 bg-paper-50 py-16 lg:py-24">
      {/*
        The same wash ProductShowcase uses, and `ellipse closest-side` for the
        same reason: a circle in a box this wide is sized to the far CORNER,
        so it is still faintly tinted where the box ends and draws a seam
        across the section instead of fading out.
      */}
      <div
        aria-hidden
        className="pointer-events-none absolute left-1/2 top-[-280px] h-[620px] w-[1100px] -translate-x-1/2"
        style={{
          background:
            "radial-gradient(ellipse closest-side, rgb(var(--tone-brand) / 0.12) 0%, rgb(var(--tone-brand) / 0) 100%)",
        }}
      />

      <div className="relative mx-auto max-w-6xl px-4 lg:px-6">
        <div className="mx-auto max-w-[860px] text-center">
          <div className="text-[11.5px] font-bold uppercase tracking-[0.22em] text-brand-600">
            Everything Your Shop Needs
          </div>
          <h2 className="mt-4 font-display text-3xl font-bold leading-[1.1] tracking-[-0.035em] text-ink-900 sm:text-4xl lg:text-[46px]">
            Designed for how small business owners <span className="text-brand-600">actually work</span>
          </h2>
          <p className="mx-auto mt-4 max-w-[600px] text-[15.5px] leading-[1.7] text-ink-600">
            No accounting background required. From paper receipts to AI answers, FinSight handles the details so you
            can focus on running your business.
          </p>
          {/* Same disclosure the showcase above carries, for the same reason. */}
          <p className="mt-2.5 text-xs text-ink-400">
            The panels are illustrations of real screens, using sample figures for an example store.
          </p>
        </div>

        <div className="relative mt-14">
          <ArrowButton direction="prev" onClick={prev} className="absolute -left-5 top-1/2 z-10 hidden -translate-y-1/2 lg:flex" />
          <ArrowButton direction="next" onClick={next} className="absolute -right-5 top-1/2 z-10 hidden -translate-y-1/2 lg:flex" />

          {/*
            `-my-*` against matching padding: the scroller clips vertically as
            well as horizontally, and without the extra room a card's hover
            lift and its drop shadow are both cut off at the edge.

            `tabIndex` because a scroll container that a mouse can pan has to
            be pannable from the keyboard too — with it, the arrow keys scroll
            the strip. That makes it a focus stop, which is why it also gets a
            role and a label.
          */}
          <div
            ref={viewportRef}
            role="region"
            aria-label="FinSight capabilities"
            tabIndex={0}
            className="-mx-4 -mb-7 -mt-4 flex snap-x snap-mandatory gap-[22px] overflow-x-auto px-4 pb-7 pt-4 [scrollbar-width:none] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 [&::-webkit-scrollbar]:hidden"
          >
            {/*
              The second copy is what Next slides onto at the end of the list.
              It is hidden from assistive technology — a screen reader reading
              the same seven cards twice is a bug, not a carousel.
            */}
            {[...FEATURES, ...FEATURES].map((feature, position) => (
              <div
                key={position < CARD_COUNT ? feature.id : `${feature.id}-loop`}
                aria-hidden={position >= CARD_COUNT}
                className="flex shrink-0 basis-full snap-start sm:basis-[calc((100%_-_22px)_/_2)] lg:basis-[calc((100%_-_44px)_/_3)]"
              >
                <FeatureCard feature={feature} />
              </div>
            ))}
          </div>

          <div className="mt-8 flex items-center justify-center gap-4">
            <ArrowButton direction="prev" onClick={prev} className="lg:hidden" />
            <div className="flex items-center gap-2">
              {FEATURES.map((feature, i) => (
                <button
                  key={feature.id}
                  type="button"
                  onClick={() => goToFeature(i)}
                  aria-label={`Show ${feature.title}`}
                  aria-current={i === active}
                  /*
                    The 8px dot is the drawing; the tap target around it is
                    44px, which is the Fitts's-Law floor and the reason this
                    is padding on a transparent button rather than a bigger
                    dot.
                  */
                  className="flex h-11 w-5 items-center justify-center"
                >
                  <span
                    className={`h-2 rounded-full transition-all duration-300 ${
                      i === active ? "w-[26px] bg-brand-900" : "w-2 bg-ink-300"
                    }`}
                  />
                </button>
              ))}
            </div>
            <ArrowButton direction="next" onClick={next} className="lg:hidden" />
          </div>
        </div>
      </div>
    </section>
  );
}
