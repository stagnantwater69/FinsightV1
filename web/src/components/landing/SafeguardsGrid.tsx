import { Bot, Camera, Lock, SquareCheck, type LucideIcon } from "lucide-react";
import { MEASURE, Rise, SectionHead } from "./grid";

/**
 * The privacy section — the page's deep-emerald register change.
 *
 * The four claims are load-bearing: each describes something the code
 * actually enforces (ownership checks, private storage with expiring links,
 * per-profile AI grounding, confirm-before-save). The copy predates this
 * redesign and must not be "improved" into marketing that outruns the code.
 */
const SAFEGUARDS: { icon: LucideIcon; title: string; body: string }[] = [
  {
    icon: Lock,
    title: "Your records stay strictly yours",
    body: "We never sell or share your data. Every request is checked against your own business profile.",
  },
  {
    icon: Camera,
    title: "Receipt photos stay private",
    body: "Uploaded secure and used only to process your transactions — view links expire in 10 minutes.",
  },
  {
    icon: Bot,
    title: "AI assistant only sees your figures",
    body: "Answers come from your own data only, never from another business's records.",
  },
  {
    icon: SquareCheck,
    title: "Explicit confirmation before storing",
    body: "You can review every scanned result and confirm it before it is saved.",
  },
];

export function SafeguardsGrid() {
  return (
    <section
      aria-labelledby="safeguards-title"
      className="landing-section-gradient-deep relative overflow-hidden bg-landing-emerald"
    >
      <div className={`${MEASURE} relative py-16 sm:py-24`}>
        {/* `items-center` on the split: the heading column is shorter than the
            card block, and top-aligning it left the imbalance the eye reads as
            dead space. */}
        <div className="grid gap-x-12 gap-y-10 lg:grid-cols-12 lg:items-center">
          <div className="lg:col-span-4">
            <SectionHead
              tone="dark"
              eyebrow="Your privacy, our priority"
              id="safeguards-title"
              title="Your records stay yours"
              lede="A store owner's sales and supplier costs are sensitive. Here is specifically what FinSight does — and what we never do."
            />
          </div>

          {/* Two up, not four. Four columns inside the 8-col half left each card
              barely 20 characters wide, so a two-sentence claim wrapped to six
              ragged lines. At two the same copy sets in three. */}
          <div className="grid gap-4 sm:grid-cols-2 lg:col-span-8">
            {SAFEGUARDS.map((s, i) => {
              const Icon = s.icon;
              return (
                <Rise key={s.title} delay={i * 70} className="h-full">
                  <div className="h-full rounded-2xl border border-landing-mint/20 bg-landing-emerald-2 p-6">
                    {/* Mint, not gold: gold is the page's CTA colour, and four
                        amber chips here read as warnings against the emerald
                        instead of as part of it. */}
                    <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-landing-mint/25 bg-gradient-to-br from-landing-mint/20 to-landing-mint/5">
                      <Icon className="h-5 w-5 text-landing-mint" aria-hidden />
                    </span>
                    <h3 className="mt-4 font-landing-display text-base font-bold leading-snug text-white">{s.title}</h3>
                    <p className="mt-2 text-sm leading-relaxed text-landing-mint/80">{s.body}</p>
                  </div>
                </Rise>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}
