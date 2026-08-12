import { PenLine, BarChart2, Sparkles, ArrowRight } from "lucide-react";

const STEPS = [
  {
    n: 1,
    icon: PenLine,
    title: "Record daily sales & expenses",
    body: "Type sales in seconds, snap receipt photos with your phone camera, or bring in spreadsheets you already use.",
    highlight: "2 minutes a day",
  },
  {
    n: 2,
    icon: BarChart2,
    title: "See your actual profit & recovery pace",
    body: "FinSight calculates your exact daily target to cover monthly bills and alerts you if expenses jump unexpectedly.",
    highlight: "Real-time daily target",
  },
  {
    n: 3,
    icon: Sparkles,
    title: "Ask FinSight anything in plain language",
    body: "Ask questions like 'Why were expenses higher this week?' and get answers generated solely from your records.",
    highlight: "Tagalog & English AI",
  },
];

export function ProcessTimeline() {
  return (
    <section className="border-t border-paper-200/80 bg-paper py-16 lg:py-24">
      <div className="mx-auto max-w-6xl px-4 lg:px-6">
        <div className="mx-auto max-w-2xl text-center">
          <div className="inline-flex items-center gap-1.5 rounded-full border border-brand-200 bg-tint-brand px-3.5 py-1 text-xs font-semibold text-brand-800">
            <span>Simple 3-Step Process</span>
          </div>
          <h2 className="mt-3 font-display text-3xl font-bold tracking-tight text-ink-900 sm:text-4xl">
            How FinSight works for your shop
          </h2>
          <p className="mt-3 text-base text-ink-600 sm:text-lg">
            Three sequential steps. Step 3 works because of the solid foundation created by steps 1 and 2.
          </p>
        </div>

        {/* Connected Steps Grid */}
        <div className="relative mt-14 grid gap-8 md:grid-cols-3">
          {/* Horizontal Connector Line for Desktop */}
          <div
            aria-hidden
            className="absolute left-1/6 right-1/6 top-10 hidden h-0.5 bg-gradient-to-r from-brand-300 via-brand-500 to-accent-400 md:block"
          />

          {STEPS.map((s) => {
            const Icon = s.icon;
            return (
              <div
                key={s.n}
                className="group relative flex flex-col justify-between rounded-3xl border border-paper-200 bg-paper-50/70 p-6 shadow-xs transition duration-300 hover:-translate-y-1 hover:border-brand-300 hover:bg-paper hover:shadow-xl sm:p-8"
              >
                <div>
                  <div className="flex items-center justify-between">
                    <div className="relative z-10 flex h-12 w-12 items-center justify-center rounded-2xl bg-brand-700 font-display text-lg font-bold text-white shadow-md transition-transform group-hover:scale-110">
                      {s.n}
                    </div>
                    <span className="rounded-full bg-paper border border-paper-200 px-3 py-1 text-xs font-semibold text-brand-700 shadow-2xs">
                      {s.highlight}
                    </span>
                  </div>

                  <div className="mt-6 flex items-center gap-2">
                    <Icon className="h-5 w-5 text-brand-600" />
                    <h3 className="font-display text-lg font-bold text-ink-900">{s.title}</h3>
                  </div>

                  <p className="mt-3 text-sm leading-relaxed text-ink-600">{s.body}</p>
                </div>

                <div className="mt-6 flex items-center gap-1 text-xs font-bold text-brand-700 opacity-0 transition-opacity group-hover:opacity-100">
                  <span>Explore step details</span>
                  <ArrowRight className="h-3.5 w-3.5" />
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
