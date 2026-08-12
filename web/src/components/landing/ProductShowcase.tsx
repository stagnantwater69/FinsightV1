import { useState } from "react";
import { Camera, Bot, Sparkles, CheckCircle2, ArrowRight, ShieldCheck, Zap } from "lucide-react";

export function ProductShowcase() {
  const [activeTab, setActiveTab] = useState<"ocr" | "ai">("ocr");

  return (
    <section className="border-t border-paper-200/80 bg-paper py-16 lg:py-24">
      <div className="mx-auto max-w-6xl px-4 lg:px-6">
        <div className="mx-auto max-w-2xl text-center">
          <div className="inline-flex items-center gap-2 rounded-full border border-brand-200 bg-brand-50/80 px-3.5 py-1 text-xs font-semibold text-brand-700">
            <Sparkles className="h-3.5 w-3.5 text-accent-500 fill-accent-400" />
            <span>Show, Don't Tell</span>
          </div>
          <h2 className="mt-4 font-display text-3xl font-bold tracking-tight text-ink-900 sm:text-4xl">
            See how FinSight handles your daily financial records
          </h2>
          <p className="mt-3 text-base text-ink-600 sm:text-lg">
            No complex accounting terms. Snap receipt photos or ask questions in plain language — your assistant does the rest.
          </p>
          {/*
            Says outright that the panels below are mocked up. They are drawn
            with sample figures for a fictional store, and without a label a
            reader is entitled to assume they are somebody's real records —
            which is the same mistake the deleted testimonials made, one step
            quieter.
          */}
          <p className="mt-3 text-xs font-medium text-ink-400">
            Illustrations of the actual screens, using sample figures for an example store.
          </p>
        </div>

        {/* Tab Switcher */}
        <div className="mt-8 flex justify-center">
          <div className="inline-flex rounded-2xl border border-paper-200 bg-paper-100/70 p-1.5 shadow-inner">
            <button
              type="button"
              onClick={() => setActiveTab("ocr")}
              className={`flex items-center gap-2.5 rounded-xl px-5 py-2.5 text-sm font-semibold transition duration-200 ${
                activeTab === "ocr"
                  ? "bg-paper text-ink-900 shadow-sm ring-1 ring-paper-200"
                  : "text-ink-500 hover:text-ink-900"
              }`}
            >
              <Camera className="h-4 w-4 text-brand-600" />
              <span>Instant Receipt OCR</span>
            </button>
            <button
              type="button"
              onClick={() => setActiveTab("ai")}
              className={`flex items-center gap-2.5 rounded-xl px-5 py-2.5 text-sm font-semibold transition duration-200 ${
                activeTab === "ai"
                  ? "bg-paper text-ink-900 shadow-sm ring-1 ring-paper-200"
                  : "text-ink-500 hover:text-ink-900"
              }`}
            >
              <Bot className="h-4 w-4 text-accent-500" />
              <span>Natural Language AI</span>
            </button>
          </div>
        </div>

        {/* Dynamic Display Area */}
        <div className="mt-10 overflow-hidden rounded-3xl border border-paper-200 bg-gradient-to-b from-paper to-paper-50/50 p-6 shadow-xl sm:p-8 lg:p-10">
          {activeTab === "ocr" ? (
            <div className="grid gap-8 lg:grid-cols-12 lg:items-center">
              {/* Left Column Description */}
              <div className="lg:col-span-5">
                <div className="inline-flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-brand-700">
                  <Zap className="h-4 w-4 fill-brand-200 text-brand-600" />
                  <span>Optical Character Recognition</span>
                </div>
                <h3 className="mt-2 font-display text-2xl font-bold text-ink-900 sm:text-3xl">
                  Turn physical paper receipts into digital records in 3 seconds
                </h3>
                <p className="mt-4 text-sm leading-relaxed text-ink-600 sm:text-base">
                  Snap a photo of your supplier invoice or store receipt with your phone camera. FinSight extracts the total, date, merchant name, and item categories automatically.
                </p>

                <ul className="mt-6 space-y-3">
                  {[
                    "Reads handwritten and thermal printed receipts",
                    "Auto-assigns tax and expense categories",
                    "Flags uncertain values for 1-tap confirmation",
                    "Original photos kept in private storage, links expire in 10 minutes",
                  ].map((item, i) => (
                    <li key={i} className="flex items-start gap-3 text-sm text-ink-700">
                      <CheckCircle2 className="h-5 w-5 shrink-0 text-brand-600" />
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
              </div>

              {/* Right Column Simulated Scanner UI */}
              <div className="lg:col-span-7">
                <div className="relative overflow-hidden rounded-2xl border border-paper-200 bg-paper p-6 shadow-md">
                  <div className="flex items-center justify-between border-b border-paper-200 pb-4">
                    <div className="flex items-center gap-3">
                      <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand-50 text-brand-700">
                        <Camera className="h-5 w-5" />
                      </div>
                      <div>
                        <div className="font-display text-sm font-bold text-ink-900">Receipt Scanner Demo</div>
                        <div className="text-xs text-ink-400">San Miguel Supplier Invoice #8402</div>
                      </div>
                    </div>
                    <span className="rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-700 border border-emerald-200/60">
                      ✓ Read from photo — check before saving
                    </span>
                  </div>

                  {/* Scanned Items Preview */}
                  <div className="mt-4 space-y-3">
                    <div className="rounded-xl border border-paper-200 bg-paper-50 p-3.5 transition hover:bg-paper-100">
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-semibold text-ink-900">Beverage Stock (24 Cases)</span>
                        <span className="font-mono text-sm font-bold text-ink-900">₱4,800.00</span>
                      </div>
                      <div className="mt-1 flex items-center justify-between text-xs text-ink-500">
                        <span>Category: Inventory Purchase</span>
                        <span className="text-brand-600 font-medium">Auto-Categorized</span>
                      </div>
                    </div>

                    <div className="rounded-xl border border-paper-200 bg-paper-50 p-3.5 transition hover:bg-paper-100">
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-semibold text-ink-900">Cooking Oil & Staples</span>
                        <span className="font-mono text-sm font-bold text-ink-900">₱1,450.00</span>
                      </div>
                      <div className="mt-1 flex items-center justify-between text-xs text-ink-500">
                        <span>Category: Grocery Supplies</span>
                        <span className="text-brand-600 font-medium">Auto-Categorized</span>
                      </div>
                    </div>
                  </div>

                  {/* Summary Bar */}
                  <div className="mt-5 flex items-center justify-between rounded-xl bg-brand-900 p-4 text-white">
                    <div>
                      <div className="text-xs text-brand-200 uppercase tracking-wider font-medium">Total Extracted</div>
                      <div className="font-mono text-xl font-bold">₱6,250.00</div>
                    </div>
                    <button
                      type="button"
                      className="flex items-center gap-1.5 rounded-lg bg-accent-400 px-4 py-2 text-xs font-bold text-ink-950 hover:bg-accent-300 transition-colors"
                    >
                      Confirm Record
                      <ArrowRight className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div className="grid gap-8 lg:grid-cols-12 lg:items-center">
              {/* Left Column Description */}
              <div className="lg:col-span-5">
                <div className="inline-flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-accent-700">
                  <Bot className="h-4 w-4 text-accent-600" />
                  <span>FinSight AI Assistant</span>
                </div>
                <h3 className="mt-2 font-display text-2xl font-bold text-ink-900 sm:text-3xl">
                  Ask financial questions in plain Tagalog or English
                </h3>
                <p className="mt-4 text-sm leading-relaxed text-ink-600 sm:text-base">
                  Curious why expenses jumped this week or how much sales you need today? Just type your question like you're talking to a partner.
                </p>

                <ul className="mt-6 space-y-3">
                  {[
                    "Answers grounded exclusively in your own recorded sales & expenses",
                    "Identifies store spending leaks and seasonal cost spikes",
                    "Calculates daily target recovery pace in real-time",
                    "Never shares your figures with outside models or third parties",
                  ].map((item, i) => (
                    <li key={i} className="flex items-start gap-3 text-sm text-ink-700">
                      <ShieldCheck className="h-5 w-5 shrink-0 text-accent-600" />
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
              </div>

              {/* Right Column AI Chat Simulation */}
              <div className="lg:col-span-7">
                <div className="relative rounded-2xl border border-paper-200 bg-paper p-5 shadow-md">
                  <div className="flex items-center justify-between border-b border-paper-200 pb-3">
                    <div className="flex items-center gap-2.5">
                      <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-accent-100 text-accent-700">
                        <Bot className="h-5 w-5" />
                      </div>
                      <div>
                        <div className="font-display text-sm font-bold text-ink-900">FinSight Assistant</div>
                        <div className="text-xs text-emerald-600 font-medium">● Connected to Aling Nena's Store Data</div>
                      </div>
                    </div>
                  </div>

                  {/* Chat Stream */}
                  <div className="mt-4 space-y-3">
                    {/* User Prompt */}
                    <div className="flex justify-end">
                      <div className="max-w-[85%] rounded-2xl bg-brand-700 px-4 py-2.5 text-sm font-medium text-white shadow-xs">
                        Why were my expenses ₱12,000 higher this week compared to last week?
                      </div>
                    </div>

                    {/* AI Response */}
                    <div className="flex justify-start">
                      <div className="max-w-[90%] rounded-2xl bg-paper-100 p-4 text-sm text-ink-900 border border-paper-200">
                        <p className="font-semibold text-brand-800">Here is what your records show:</p>
                        <p className="mt-2 text-xs leading-relaxed text-ink-700">
                          Your expenses increased primarily due to two large supplier purchases on Tuesday and Thursday:
                        </p>
                        <ul className="mt-2 space-y-1.5 text-xs text-ink-800">
                          <li className="flex justify-between border-b border-paper-200 pb-1">
                            <span>• San Miguel Beverage Restock</span>
                            <span className="font-mono font-bold">₱8,500.00</span>
                          </li>
                          <li className="flex justify-between">
                            <span>• LPG Tank Replacement</span>
                            <span className="font-mono font-bold">₱3,500.00</span>
                          </li>
                        </ul>
                        <div className="mt-3 rounded-lg bg-amber-50 p-2.5 text-xs text-amber-900 border border-amber-200">
                          💡 <strong>Recovery Tip:</strong> To maintain your monthly goal of ₱125,000, your daily sales target for the next 7 days adjusts from ₱4,500 to ₱5,100/day.
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
