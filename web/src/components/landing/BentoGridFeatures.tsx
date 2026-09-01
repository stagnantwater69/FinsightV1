import { AlertCircle, ArrowRight, Check, FileSpreadsheet, FileText, RefreshCw } from "lucide-react";
import { Card, MEASURE, Rise, SectionHead } from "./grid";
import { CurveDivider, MintGlow } from "./FinancialTrail";

/**
 * The bento feature grid: seven capabilities, each a card with a title, a
 * benefit sentence and a small interface preview. Card widths vary on large
 * screens (4-up row, then 3-up row) but reading order stays left-to-right.
 * Every preview is example markup, aria-hidden; the words carry the claim.
 */

function PreviewFrame({ children }: { children: React.ReactNode }) {
  return (
    <div aria-hidden className="mb-4 rounded-xl border border-landing-mint-light/70 bg-landing-mint-pale/50 p-3.5">
      {children}
    </div>
  );
}

function OcrPreview() {
  return (
    <PreviewFrame>
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-[11px] font-semibold text-landing-charcoal">San Miguel Supplier</p>
          <p className="text-[10px] text-landing-muted">Invoice #1602 · May 31, 2024</p>
          <p className="figure mt-1.5 text-sm font-bold text-landing-charcoal">₱4,600.00</p>
        </div>
        <span className="flex items-center gap-1 rounded-full bg-landing-emerald px-2 py-0.5 text-[9px] font-bold text-landing-mint">
          <Check className="h-2.5 w-2.5" strokeWidth={3} />
          Captured
        </span>
      </div>
    </PreviewFrame>
  );
}

function MeterPreview() {
  return (
    <PreviewFrame>
      <div className="flex items-baseline justify-between">
        <p className="text-[10px] font-semibold text-landing-muted">Monthly target</p>
        <p className="figure text-[11px] font-bold text-landing-green">67% covered</p>
      </div>
      <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-landing-mint-light">
        <div className="h-full w-[67%] rounded-full bg-gradient-to-r from-landing-green to-accent-400" />
      </div>
      <div className="mt-2.5 flex items-baseline justify-between">
        <p className="text-[10px] text-landing-muted">Today's needed pace</p>
        <p className="figure text-[11px] font-bold text-landing-charcoal">₱4,500/day</p>
      </div>
    </PreviewFrame>
  );
}

function AiPreview() {
  return (
    <PreviewFrame>
      <p className="w-fit rounded-lg rounded-bl-sm bg-landing-surface px-2.5 py-1.5 text-[10px] font-medium text-landing-charcoal shadow-sm">
        How was my profit this week?
      </p>
      <p className="ml-auto mt-2 w-fit max-w-[90%] rounded-lg rounded-br-sm bg-landing-emerald px-2.5 py-1.5 text-[10px] leading-snug text-landing-mint">
        Your profit this week is <span className="figure font-bold text-white">₱7,314.00</span> with a margin of 27.9%.
      </p>
    </PreviewFrame>
  );
}

function AlertPreview() {
  return (
    <PreviewFrame>
      <p className="flex items-center gap-1.5 text-[11px] font-bold text-landing-red">
        <AlertCircle className="h-3.5 w-3.5" />
        Possible overcharge detected
      </p>
      <p className="mt-1 text-[10px] text-landing-muted">
        at Puregold — <span className="figure font-semibold text-landing-charcoal">₱120.00</span> above usual
      </p>
      <p className="mt-1.5 flex items-center gap-1 text-[10px] font-bold text-landing-green">
        Review now
        <ArrowRight className="h-2.5 w-2.5" />
      </p>
    </PreviewFrame>
  );
}

function AnalyticsPreview() {
  return (
    <PreviewFrame>
      <div className="flex items-baseline justify-between">
        <p className="text-[10px] font-semibold text-landing-muted">Cash Flow (This Month)</p>
        <p className="figure text-[11px] font-bold text-landing-charcoal">₱26,250.00</p>
      </div>
      <svg viewBox="0 0 200 44" preserveAspectRatio="none" className="mt-2 h-11 w-full">
        <path d="M0 38 L25 34 L50 36 L75 26 L100 30 L125 18 L150 22 L175 10 L200 6 L200 44 L0 44 Z" fill="#CDEEE0" />
        <path
          d="M0 38 L25 34 L50 36 L75 26 L100 30 L125 18 L150 22 L175 10 L200 6"
          fill="none"
          stroke="#0C7A62"
          strokeWidth="2"
          strokeLinecap="round"
        />
      </svg>
    </PreviewFrame>
  );
}

function SyncPreview() {
  return (
    <div aria-hidden className="relative mb-4 overflow-hidden rounded-xl border border-landing-mint-light/70">
      <img
        src="/landing/sync.webp"
        alt=""
        width={706}
        height={512}
        loading="lazy"
        className="h-28 w-full object-cover"
      />
      <span className="absolute left-1/2 top-1/2 flex h-8 w-8 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-landing-surface/90 shadow-sm">
        <RefreshCw className="h-4 w-4 text-landing-green" />
      </span>
    </div>
  );
}

function ExportPreview() {
  return (
    <PreviewFrame>
      <div className="flex items-center justify-center gap-4 py-1">
        <span className="flex flex-col items-center gap-1">
          <FileSpreadsheet className="h-8 w-8 text-landing-green" strokeWidth={1.5} />
          <span className="rounded bg-landing-green px-1.5 py-0.5 text-[8px] font-bold text-white">XLSX</span>
        </span>
        <span className="flex flex-col items-center gap-1">
          <FileText className="h-8 w-8 text-landing-emerald" strokeWidth={1.5} />
          <span className="rounded bg-landing-emerald px-1.5 py-0.5 text-[8px] font-bold text-white">CSV</span>
        </span>
      </div>
    </PreviewFrame>
  );
}

const FEATURES: { title: string; body: string; preview: () => React.ReactNode; span: string }[] = [
  {
    title: "Instant Receipt OCR & Shop Recording",
    body: "Snap receipts and let FinSight extract the details for you to verify and record in seconds.",
    preview: OcrPreview,
    span: "lg:col-span-3",
  },
  {
    title: "Dynamic Recovery Meter",
    body: "Know exactly how much you're recovering to cover monthly fixed expenses and loan or savings goals.",
    preview: MeterPreview,
    span: "lg:col-span-3",
  },
  {
    title: "Natural Language AI Assistant",
    body: "Ask questions in plain language and get clear answers built only from your own records.",
    preview: AiPreview,
    span: "lg:col-span-3",
  },
  {
    title: "Expense & Overcharge Alerts",
    body: "FinSight flags unusually high spend or an overcharge from your supplier before it drains profit.",
    preview: AlertPreview,
    span: "lg:col-span-3",
  },
  {
    title: "Sales & Cash Flow Analytics",
    body: "Visual charts that show where money comes in and goes out, without spreadsheet headaches.",
    preview: AnalyticsPreview,
    span: "lg:col-span-4",
  },
  {
    title: "Real-Time Phone & Web Synchronization",
    body: "Use your phone behind the counter or the dashboard at home — your records stay in sync.",
    preview: SyncPreview,
    span: "lg:col-span-4",
  },
  {
    title: "One-Click Excel / CSV Export",
    body: "Export clean, formatted files anytime for your accountant or BIR filing needs.",
    preview: ExportPreview,
    span: "lg:col-span-4",
  },
];

export function BentoGridFeatures() {
  return (
    <section
      id="features"
      aria-labelledby="features-title"
      className="landing-section-gradient-base relative scroll-mt-20 overflow-hidden bg-landing-cream"
    >
      {/* the workflow's pale mint arcs down into the cream */}
      <CurveDivider from="mint-pale" className="relative z-10" />
      <div className={`${MEASURE} relative py-16 sm:py-24`}>
        <SectionHead
          eyebrow="Everything your shop needs"
          id="features-title"
          title="Designed for how small business owners actually work"
          lede="No accounting background required. From paper receipts to plain-language answers, FinSight handles the details so you can focus on running your shop."
        />

        <div className="relative mt-10 grid grid-cols-1 gap-5 md:grid-cols-2 lg:grid-cols-12">
          <MintGlow className="left-1/4 top-1/3 h-72 w-72 opacity-40" />
          {FEATURES.map((f, i) => (
            <Rise key={f.title} delay={Math.min(i, 5) * 55} className={`relative ${f.span}`}>
              <Card hover className="flex h-full flex-col p-5">
                <h3 className="mb-4 font-landing-display text-[16px] font-bold leading-snug text-landing-charcoal">{f.title}</h3>
                <div className="mt-auto">
                  {f.preview()}
                  <p className="text-[13.5px] leading-relaxed text-landing-muted">{f.body}</p>
                </div>
              </Card>
            </Rise>
          ))}
        </div>
      </div>
    </section>
  );
}
