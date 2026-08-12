import {
  Scan,
  TrendingUp,
  MessageSquare,
  AlertTriangle,
  BarChart3,
  Smartphone,
  FileSpreadsheet,
  ArrowUpRight,
  Check
} from "lucide-react";

export function BentoGridFeatures() {
  return (
    <section id="features" className="scroll-mt-24 border-t border-paper-200/80 bg-paper-50 py-16 lg:py-24">
      <div className="mx-auto max-w-6xl px-4 lg:px-6">
        {/* Section Header */}
        <div className="mx-auto max-w-2xl text-center">
          <div className="inline-flex items-center gap-1.5 rounded-full border border-brand-200 bg-tint-brand px-3.5 py-1 text-xs font-semibold text-brand-800">
            <span>Everything Your Shop Needs</span>
          </div>
          <h2 className="mt-3 font-display text-3xl font-bold tracking-tight text-ink-900 sm:text-4xl">
            Designed for how small business owners actually work
          </h2>
          <p className="mt-3 text-base text-ink-600 sm:text-lg">
            No accounting background required. From paper receipts to AI answers, FinSight handles the details so you can focus on running your business.
          </p>
        </div>

        {/* Asymmetric Bento Grid */}
        <div className="mt-12 grid gap-6 md:grid-cols-2 lg:grid-cols-3">
          
          {/* Bento Card 1: AI Receipt Reader (Spans 2 columns on lg) */}
          <div className="group relative overflow-hidden rounded-3xl border border-paper-200 bg-paper p-6 shadow-xs transition duration-300 hover:-translate-y-1 hover:border-brand-300 hover:shadow-xl lg:col-span-2">
            <div className="flex items-center justify-between">
              <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-brand-50 text-brand-700">
                <Scan className="h-6 w-6" />
              </div>
              <span className="rounded-full bg-brand-50 px-3 py-1 text-xs font-semibold text-brand-700">
                Signature Feature
              </span>
            </div>

            <div className="mt-5">
              <h3 className="font-display text-xl font-bold text-ink-900">
                Instant Receipt OCR & Snap Recording
              </h3>
              <p className="mt-2 text-sm leading-relaxed text-ink-600">
                Never waste time typing long supplier receipts. Point your phone camera, snap a photo, and watch FinSight parse items, dates, and amounts into organized expense records.
              </p>
            </div>

            {/* Micro Mockup UI */}
            <div className="mt-6 rounded-2xl border border-paper-200 bg-paper-50 p-4">
              <div className="flex items-center justify-between text-xs font-medium text-ink-500">
                <span>Receipt #9281 • Puregold Supermarket</span>
                <span className="flex items-center gap-1 font-semibold text-emerald-600">
                  <Check className="h-3.5 w-3.5" /> High Confidence
                </span>
              </div>
              <div className="mt-3 space-y-2">
                <div className="flex items-center justify-between rounded-lg bg-paper p-2.5 text-xs">
                  <span className="font-semibold text-ink-900">Cooking Oil 2L (10 Bottles)</span>
                  <span className="font-mono font-bold text-ink-900">₱1,850.00</span>
                </div>
                <div className="flex items-center justify-between rounded-lg bg-paper p-2.5 text-xs">
                  <span className="font-semibold text-ink-900">Refined Sugar 50kg Bag</span>
                  <span className="font-mono font-bold text-ink-900">₱2,900.00</span>
                </div>
              </div>
            </div>
          </div>

          {/* Bento Card 2: Recovery Pace Meter */}
          <div className="group relative overflow-hidden rounded-3xl border border-paper-200 bg-paper p-6 shadow-xs transition duration-300 hover:-translate-y-1 hover:border-brand-300 hover:shadow-xl">
            <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-amber-50 text-accent-600">
              <TrendingUp className="h-6 w-6" />
            </div>
            <div className="mt-5">
              <h3 className="font-display text-lg font-bold text-ink-900">
                Dynamic Recovery Meter
              </h3>
              <p className="mt-2 text-sm leading-relaxed text-ink-600">
                Know exact daily sales targets needed to cover monthly fixed expenses and turn a profit.
              </p>
            </div>

            {/* Mini Progress Widget */}
            <div className="mt-6 rounded-2xl border border-paper-200 bg-paper-50 p-4">
              <div className="flex justify-between text-xs font-bold text-ink-900">
                <span>Monthly Target</span>
                <span className="text-accent-600">67% Covered</span>
              </div>
              <div className="mt-2 h-3 overflow-hidden rounded-full bg-paper-200">
                <div className="h-full w-[67%] rounded-full bg-gradient-to-r from-accent-400 to-amber-500" />
              </div>
              <div className="mt-3 flex justify-between text-xs text-ink-500">
                <span>Today's Needed Pace:</span>
                <span className="font-mono font-bold text-ink-900">₱4,500/day</span>
              </div>
            </div>
          </div>

          {/* Bento Card 3: AI Assistant Q&A */}
          <div className="group relative overflow-hidden rounded-3xl border border-paper-200 bg-paper p-6 shadow-xs transition duration-300 hover:-translate-y-1 hover:border-brand-300 hover:shadow-xl">
            <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-sky-50 text-sky-600">
              <MessageSquare className="h-6 w-6" />
            </div>
            <div className="mt-5">
              <h3 className="font-display text-lg font-bold text-ink-900">
                Natural Language AI Assistant
              </h3>
              <p className="mt-2 text-sm leading-relaxed text-ink-600">
                Ask questions in plain conversational language and get insights built straight from your records.
              </p>
            </div>

            <div className="mt-6 rounded-2xl border border-paper-200 bg-paper-50 p-3.5 text-xs">
              <div className="rounded-xl bg-brand-700 p-2.5 font-medium text-white">
                "What was my best selling day this month?"
              </div>
              <div className="mt-2 rounded-xl bg-paper p-2.5 text-ink-700 border border-paper-200">
                "Saturday July 12 with ₱18,400 in sales."
              </div>
            </div>
          </div>

          {/* Bento Card 4: Expense Anomaly Detector */}
          <div className="group relative overflow-hidden rounded-3xl border border-paper-200 bg-paper p-6 shadow-xs transition duration-300 hover:-translate-y-1 hover:border-brand-300 hover:shadow-xl">
            <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-rose-50 text-rose-600">
              <AlertTriangle className="h-6 w-6" />
            </div>
            <div className="mt-5">
              <h3 className="font-display text-lg font-bold text-ink-900">
                Expense & Overcharge Alerts
              </h3>
              <p className="mt-2 text-sm leading-relaxed text-ink-600">
                FinSight flags unusually high supplier charges before they drain your operating profit.
              </p>
            </div>

            <div className="mt-6 rounded-2xl border border-rose-200 bg-rose-50/60 p-3.5">
              <div className="flex items-center gap-2 text-xs font-bold text-rose-800">
                <AlertTriangle className="h-4 w-4 shrink-0 text-rose-600" />
                <span>Supplier Price Spike Flagged</span>
              </div>
              <p className="mt-1 text-xs text-rose-700">
                Flour purchase was +22% higher than your 30-day average.
              </p>
            </div>
          </div>

          {/* Bento Card 5: Real-Time Sales & Cash Flow */}
          <div className="group relative overflow-hidden rounded-3xl border border-paper-200 bg-paper p-6 shadow-xs transition duration-300 hover:-translate-y-1 hover:border-brand-300 hover:shadow-xl">
            <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-emerald-50 text-emerald-600">
              <BarChart3 className="h-6 w-6" />
            </div>
            <div className="mt-5">
              <h3 className="font-display text-lg font-bold text-ink-900">
                Sales & Cash Flow Analytics
              </h3>
              <p className="mt-2 text-sm leading-relaxed text-ink-600">
                Visual charts that make revenue trends crystal clear without spreadsheet headaches.
              </p>
            </div>

            {/* Mini Bar Chart Mockup */}
            <div className="mt-6 flex items-end gap-2 rounded-2xl border border-paper-200 bg-paper-50 p-4 h-24">
              {[40, 65, 45, 90, 75, 100, 85].map((h, idx) => (
                // h-full on the column matters: a percentage height resolves
                // against the parent's height, and without it the column was
                // auto-height, so every bar computed to zero and the card
                // rendered as an empty box.
                <div key={idx} className="flex h-full flex-1 flex-col justify-end items-center gap-1">
                  <div
                    className="w-full rounded-t-md bg-brand-500 transition hover:bg-brand-600"
                    style={{ height: `${h}%` }}
                  />
                </div>
              ))}
            </div>
          </div>

          {/* Bento Card 6: Multi-Device Sync (Spans 2 cols on lg) */}
          <div className="group relative overflow-hidden rounded-3xl border border-paper-200 bg-paper p-6 shadow-xs transition duration-300 hover:-translate-y-1 hover:border-brand-300 hover:shadow-xl lg:col-span-2">
            <div className="flex items-center justify-between">
              <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-indigo-50 text-indigo-600">
                <Smartphone className="h-6 w-6" />
              </div>
              <div className="flex items-center gap-1.5 rounded-full border border-paper-200 bg-paper-100 px-3 py-1 text-xs font-semibold text-ink-700">
                <span>Web + Mobile Responsive</span>
              </div>
            </div>

            <div className="mt-5 grid gap-6 sm:grid-cols-2 sm:items-center">
              <div>
                <h3 className="font-display text-xl font-bold text-ink-900">
                  Real-Time Phone & Web Synchronization
                </h3>
                <p className="mt-2 text-sm leading-relaxed text-ink-600">
                  Log sales on your smartphone behind the counter, then view full monthly analytics on your laptop at home. Your records stay perfectly in sync.
                </p>
              </div>
              <div className="rounded-2xl border border-paper-200 bg-paper-50 p-4 text-xs space-y-2">
                <div className="flex items-center justify-between font-semibold text-ink-800">
                  <span className="flex items-center gap-1.5">
                    <Smartphone className="h-4 w-4 text-brand-600" /> Mobile App
                  </span>
                  <span className="text-emerald-600">Synced ●</span>
                </div>
                <div className="flex items-center justify-between font-semibold text-ink-800">
                  <span className="flex items-center gap-1.5">
                    <FileSpreadsheet className="h-4 w-4 text-brand-600" /> Web Dashboard
                  </span>
                  <span className="text-emerald-600">Synced ●</span>
                </div>
              </div>
            </div>
          </div>

          {/* Bento Card 7: Export & Backup */}
          <div className="group relative overflow-hidden rounded-3xl border border-paper-200 bg-paper p-6 shadow-xs transition duration-300 hover:-translate-y-1 hover:border-brand-300 hover:shadow-xl">
            <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-amber-50 text-amber-700">
              <FileSpreadsheet className="h-6 w-6" />
            </div>
            <div className="mt-5">
              <h3 className="font-display text-lg font-bold text-ink-900">
                One-Click Excel / CSV Export
              </h3>
              <p className="mt-2 text-sm leading-relaxed text-ink-600">
                Export clean, formatted spreadsheets anytime for your accountant or tax filings.
              </p>
            </div>
            <div className="mt-6 flex items-center justify-between rounded-xl border border-paper-200 bg-paper-50 p-3 text-xs font-semibold text-ink-800">
              <span>finsight_sales_july.csv</span>
              <ArrowUpRight className="h-4 w-4 text-brand-600" />
            </div>
          </div>

        </div>
      </div>
    </section>
  );
}
