import { ShieldCheck, Lock, EyeOff, FileCheck2 } from "lucide-react";

const SAFEGUARDS = [
  {
    icon: ShieldCheck,
    title: "Your records stay strictly yours",
    body: "Every request is validated against your business profile on the server. One owner's records are strictly isolated from all other accounts.",
  },
  {
    icon: Lock,
    title: "Receipt photos stay private",
    body: "Uploaded receipt images sit in private storage buckets. Viewing one generates a temporary link that expires automatically after 10 minutes.",
  },
  {
    icon: EyeOff,
    title: "AI assistant only sees your figures",
    body: "Answers are derived exclusively from your uploaded numbers. The AI model never shares your data or sees figures from other stores.",
  },
  {
    icon: FileCheck2,
    title: "Explicit confirmation before saving",
    body: "Values read from receipt scans are shown to you for checking first. FinSight flags low-confidence figures so nothing is filed quietly.",
  },
];

export function SafeguardsGrid() {
  return (
    <section className="border-t border-brand-900 bg-brand-950 py-16 text-white lg:py-24">
      <div className="mx-auto max-w-6xl px-4 lg:px-6">
        <div className="mx-auto max-w-2xl text-center">
          <div className="inline-flex items-center gap-1.5 rounded-full border border-brand-700 bg-brand-900/80 px-3.5 py-1 text-xs font-semibold text-brand-200">
            <Lock className="h-3.5 w-3.5 text-accent-400" />
            <span>Privacy &amp; Security</span>
          </div>
          <h2 className="mt-3 font-display text-3xl font-bold tracking-tight text-white sm:text-4xl">
            Your records stay yours
          </h2>
          <p className="mt-3 text-base text-brand-200 sm:text-lg">
            A store owner's sales and supplier costs are sensitive. Here is specifically what FinSight does about that, and each one is enforced in code.
          </p>
        </div>

        {/* 2x2 Dark Glass Grid */}
        <div className="mt-12 grid gap-6 sm:grid-cols-2">
          {SAFEGUARDS.map((s, idx) => {
            const Icon = s.icon;
            return (
              <div
                key={idx}
                className="group flex gap-5 rounded-3xl border border-brand-800/70 bg-brand-900/40 p-6 backdrop-blur-md transition duration-300 hover:border-brand-600 hover:bg-brand-900/70"
              >
                <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-brand-800/80 text-accent-400 shadow-inner group-hover:bg-accent-400 group-hover:text-ink-950 transition-colors">
                  <Icon className="h-6 w-6 stroke-[2.2]" />
                </div>
                <div>
                  <h3 className="font-display text-lg font-bold text-white">{s.title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-brand-200/90">{s.body}</p>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
