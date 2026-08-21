import { useState } from "react";
import { Camera, Bot, ArrowRight, Zap, Check } from "lucide-react";

/**
 * "Show, Don't Tell" — the section directly under the hero.
 *
 * The hero makes the claim; this is where it gets demonstrated. Two tabs,
 * each one a drawn illustration of a screen that exists in the app: the
 * receipt scanner's review step, and the AI assistant's answer.
 *
 * THE PANELS ARE ILLUSTRATIONS AND SAY SO. The figures are invented for an
 * example store, and the caption under the heading states that outright —
 * the same rule the hero's demo panel follows, and for the same reason. See
 * the note at the top of pages/Landing.tsx for what got deleted from this
 * page for breaking it.
 *
 * Everything here is theme-driven (`ink-*`, `paper-*`, `tint-*`), unlike the
 * hero directly above, which pins its own literals because it has to stay the
 * same deep green in all three themes. This section is a reading surface, so
 * it takes the tokens and follows the theme like the rest of the page.
 */

interface TabCopy {
  eyebrow: string;
  heading: string;
  body: string;
  bullets: string[];
}

const COPY: Record<"ocr" | "ai", TabCopy> = {
  ocr: {
    eyebrow: "Optical Character Recognition",
    heading: "Turn physical paper receipts into digital records in 3 seconds",
    body: "Snap a photo of your supplier invoice or store receipt with your phone camera. FinSight extracts the total, date, merchant name, and item categories automatically.",
    bullets: [
      "Reads handwritten and thermal printed receipts",
      "Auto-assigns tax and expense categories",
      "Flags uncertain values for 1-tap confirmation",
      "Original photos kept in private storage, links expire in 10 minutes",
    ],
  },
  ai: {
    eyebrow: "FinSight AI Assistant",
    heading: "Ask financial questions in plain Tagalog or English",
    body: "Curious why expenses jumped this week or how much sales you need today? Just type your question like you're talking to a partner.",
    bullets: [
      "Answers grounded exclusively in your own recorded sales & expenses",
      "Identifies store spending leaks and seasonal cost spikes",
      "Calculates daily target recovery pace in real-time",
      "Never shares your figures with outside models or third parties",
    ],
  },
};

/** The rows the scanner illustration shows as read off the photo. */
const SCANNED_ITEMS = [
  { label: "Beverage Stock (24 Cases)", category: "Inventory Purchase", amount: "₱4,800.00" },
  { label: "Cooking Oil & Staples", category: "Grocery Supplies", amount: "₱1,450.00" },
];

/** The purchases the assistant's answer breaks the week's rise down into. */
const ANSWER_LINES = [
  { label: "San Miguel Beverage Restock", amount: "₱8,500.00" },
  { label: "LPG Tank Replacement", amount: "₱3,500.00" },
];

/**
 * Shared chrome for both illustrations: the icon square, a title, a subtitle,
 * and an optional badge.
 *
 * `min-h` plus the flex column is what lets each panel push its footer — the
 * total bar, the composer — to the bottom, so the two tabs come out the same
 * height and switching between them does not resize the card underneath the
 * reader's cursor.
 */
function PanelShell({
  icon: Icon,
  title,
  subtitle,
  badge,
  children,
}: {
  icon: React.ElementType;
  title: string;
  subtitle: React.ReactNode;
  badge?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex h-full min-h-[372px] flex-col rounded-[18px] border border-paper-200 bg-paper p-[22px] shadow-[0_10px_30px_rgba(6,35,28,0.07)]">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-paper-200 pb-4">
        <div className="flex items-center gap-[11px]">
          <span className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[10px] border border-edge-brand bg-tint-brand">
            <Icon className="h-[17px] w-[17px] text-brand-600" />
          </span>
          <div>
            <div className="font-display text-[14.5px] font-bold text-ink-900">{title}</div>
            <div className="mt-0.5 text-xs text-ink-400">{subtitle}</div>
          </div>
        </div>
        {badge}
      </div>
      {children}
    </div>
  );
}

export function ProductShowcase() {
  const [activeTab, setActiveTab] = useState<"ocr" | "ai">("ocr");
  const copy = COPY[activeTab];

  const tabClass = (isActive: boolean) =>
    `flex items-center gap-2 rounded-full px-5 py-[11px] text-[13px] transition duration-200 ${
      isActive ? "bg-brand-900 font-bold text-white" : "font-semibold text-ink-500 hover:text-ink-900"
    }`;

  return (
    <section className="relative overflow-hidden border-t border-paper-200/80 bg-paper-50 py-16 lg:py-24">
      {/*
        The wash that lifts the section off the flat page, bleeding down from
        the hero's bottom edge.

        `ellipse closest-side`, not the mockup's plain `circle`, for the same
        reason the hero's halo is — a circle in a box this wide is sized to the
        far CORNER, so it is still faintly tinted where the box ends and draws
        a seam across the section instead of fading out.
      */}
      <div
        aria-hidden
        className="pointer-events-none absolute left-1/2 top-[-320px] h-[760px] w-[1200px] -translate-x-1/2"
        style={{
          background:
            "radial-gradient(ellipse closest-side, rgb(var(--tone-brand) / 0.11) 0%, rgb(var(--tone-brand) / 0) 100%)",
        }}
      />

      <div className="relative mx-auto max-w-6xl px-4 lg:px-6">
        <div className="mx-auto max-w-[820px] text-center">
          {/*
            A letterspaced eyebrow rather than the pill badge the sections
            further down use. This one sits immediately under the hero's own
            badge, and a second pill that close reads as the page stuttering.
          */}
          <div className="text-[11.5px] font-bold uppercase tracking-[0.22em] text-brand-600">Show, Don't Tell</div>

          <h2 className="mt-4 font-display text-3xl font-bold leading-[1.1] tracking-[-0.035em] text-ink-900 sm:text-4xl lg:text-[46px]">
            See how FinSight handles your <span className="text-brand-600">daily financial records</span>
          </h2>
          <p className="mx-auto mt-4 max-w-[600px] text-[15.5px] leading-[1.7] text-ink-600">
            No complex accounting terms. Snap receipt photos or ask questions in plain language — your assistant does
            the rest.
          </p>
          {/*
            Says outright that the panels below are mocked up. They are drawn
            with sample figures for a fictional store, and without a label a
            reader is entitled to assume they are somebody's real records —
            which is the same mistake the deleted testimonials made, one step
            quieter.
          */}
          <p className="mt-2.5 text-xs text-ink-400">
            Illustrations of the actual screens, using sample figures for an example store.
          </p>

          {/*
            Two toggles rather than a full `role="tablist"`. A tablist owes the
            reader arrow-key navigation and a roving tabindex; these are two
            adjacent buttons, and the hero above already sets the precedent
            (`aria-pressed` on its store picker). Same pattern twice beats two
            different ones on one page.
          */}
          <div className="mt-7 inline-flex items-center gap-1 rounded-full border border-paper-200 bg-paper p-[5px]">
            <button
              type="button"
              onClick={() => setActiveTab("ocr")}
              aria-pressed={activeTab === "ocr"}
              className={tabClass(activeTab === "ocr")}
            >
              <Camera className="h-[15px] w-[15px] shrink-0" />
              <span>Instant Receipt OCR</span>
            </button>
            <button
              type="button"
              onClick={() => setActiveTab("ai")}
              aria-pressed={activeTab === "ai"}
              className={tabClass(activeTab === "ai")}
            >
              <Bot className="h-[15px] w-[15px] shrink-0" />
              <span>Natural Language AI</span>
            </button>
          </div>
        </div>

        {/* The stage the illustrations sit on. */}
        <div className="relative mt-11 overflow-hidden rounded-[22px] border border-paper-200 bg-gradient-to-br from-paper via-paper to-paper-50 p-6 shadow-[0_10px_30px_rgba(6,35,28,0.06)] sm:p-8 lg:p-[38px]">
          <div
            aria-hidden
            className="pointer-events-none absolute -right-24 -top-32 h-80 w-80 rounded-full opacity-90 blur-[18px]"
            style={{
              background:
                "radial-gradient(circle at 36% 38%, rgb(var(--tone-brand) / 0.34) 0%, rgb(var(--tone-brand) / 0.14) 48%, rgb(var(--tone-brand) / 0) 74%)",
            }}
          />

          <div className="relative grid gap-9 lg:grid-cols-12 lg:items-stretch">
            {/*
              One left column serving both tabs, driven by COPY. It used to be
              two near-identical copies of this markup inside the tab ternary,
              which meant every spacing fix had to be made twice and generally
              was made once.
            */}
            <div className="flex flex-col lg:col-span-5">
              <div className="flex items-center gap-2 text-[10.5px] font-bold uppercase tracking-[0.18em] text-ink-400">
                <Zap className="h-3.5 w-3.5 shrink-0" />
                <span>{copy.eyebrow}</span>
              </div>
              <h3 className="mt-4 font-display text-2xl font-bold leading-[1.18] tracking-[-0.025em] text-ink-900 sm:text-3xl lg:text-[33px]">
                {copy.heading}
              </h3>
              <p className="mt-4 text-[15px] leading-[1.7] text-ink-600">{copy.body}</p>

              <ul className="mt-6 space-y-3.5">
                {copy.bullets.map((item) => (
                  <li key={item} className="flex items-start gap-[11px]">
                    <span className="mt-px flex h-[21px] w-[21px] shrink-0 items-center justify-center rounded-full border border-edge-brand bg-tint-brand">
                      <Check className="h-[11px] w-[11px] stroke-[3.4] text-brand-600" />
                    </span>
                    <span className="text-[14.5px] leading-[1.55] text-ink-700">{item}</span>
                  </li>
                ))}
              </ul>
            </div>

            <div className="lg:col-span-7">
              {activeTab === "ocr" ? (
                <PanelShell
                  icon={Camera}
                  title="Receipt Scanner Demo"
                  subtitle="San Miguel Supplier Invoice #8402"
                  badge={
                    <span className="rounded-full border border-edge-brand bg-tint-brand px-[11px] py-[5px] text-[11px] font-bold text-tone-brand">
                      ✓ Read from photo — check before saving
                    </span>
                  }
                >
                  <div className="my-4 space-y-3">
                    {SCANNED_ITEMS.map((item) => (
                      <div
                        key={item.label}
                        className="flex items-center justify-between gap-3.5 rounded-xl border border-paper-200 bg-paper-50 px-4 py-3.5"
                      >
                        <div>
                          <div className="text-sm font-bold text-ink-900">{item.label}</div>
                          <div className="mt-[3px] text-xs text-ink-400">Category: {item.category}</div>
                        </div>
                        <div className="shrink-0 text-right">
                          <div className="text-sm font-bold tabular-nums text-ink-900">{item.amount}</div>
                          <div className="mt-[3px] text-[11.5px] font-semibold text-brand-600">Auto-Categorized</div>
                        </div>
                      </div>
                    ))}
                  </div>

                  <div className="mt-auto flex flex-wrap items-center justify-between gap-4 rounded-[14px] bg-brand-900 px-5 py-[18px]">
                    <div>
                      <div className="text-[11px] font-bold tracking-[0.1em] text-brand-200">TOTAL EXTRACTED</div>
                      <div className="mt-1 text-[23px] font-extrabold tabular-nums text-white">₱6,250.00</div>
                    </div>
                    {/*
                      A SPAN, not a button. This is part of the drawing — there
                      is nothing on a landing page to confirm — and a real
                      <button> here is a focus stop that takes a keyboard
                      user's Enter and does nothing with it.

                      Amber rather than the mockup's dark green, which drew
                      #0b3d2c on a #0b3d2c bar and disappeared into it.
                      `accent-400` is reserved in tailwind.config.js for
                      precisely this — Save/Confirm — so the illustration ends
                      up showing the colour the real Confirm button wears.
                    */}
                    <span className="flex items-center gap-2 rounded-full bg-accent-400 px-[18px] py-[11px] text-[13px] font-bold text-ink-950">
                      Confirm Record
                      <ArrowRight className="h-3.5 w-3.5 stroke-[2.6]" />
                    </span>
                  </div>
                </PanelShell>
              ) : (
                <PanelShell
                  icon={Bot}
                  title="FinSight Assistant"
                  subtitle={
                    <span className="flex items-center gap-1.5 font-semibold text-brand-600">
                      <span className="h-1.5 w-1.5 rounded-full bg-brand-500" />
                      Connected to Aling Nena's Store Data
                    </span>
                  }
                >
                  <div className="mb-2.5 mt-3.5 flex justify-end">
                    <div className="max-w-[82%] rounded-[14px] rounded-br-[4px] bg-brand-900 px-4 py-3 text-[13.5px] font-medium leading-[1.5] text-white">
                      Why were my expenses ₱12,000 higher this week?
                    </div>
                  </div>

                  <div className="rounded-[14px] border border-paper-200 bg-paper-50 px-[18px] py-4">
                    <div className="text-[13.5px] font-bold text-ink-900">Here is what your records show:</div>
                    <ul className="mb-3.5 mt-2 space-y-2">
                      {ANSWER_LINES.map((line) => (
                        <li key={line.label} className="flex justify-between gap-3 text-[13px] text-ink-900">
                          <span>• {line.label}</span>
                          <span className="font-bold tabular-nums">{line.amount}</span>
                        </li>
                      ))}
                    </ul>
                    <div className="rounded-[11px] border border-edge-brand bg-tint-brand px-3.5 py-3 text-[12.5px] leading-[1.55] text-ink-700">
                      <strong className="font-bold text-tone-brand">Recovery Tip:</strong> To keep your ₱125,000 monthly
                      goal, your daily target moves from ₱4,500 to ₱5,100.
                    </div>
                  </div>

                  {/*
                    The composer, drawn rather than built: no input, no send
                    handler, and hidden from screen readers, which would
                    otherwise announce a text field that cannot be typed into.
                    Its only job is to show where the question goes.
                  */}
                  <div
                    aria-hidden
                    className="mt-auto flex items-center gap-2.5 rounded-full border border-paper-200 py-2.5 pl-4 pr-2.5"
                  >
                    <span className="flex-1 text-[13px] text-ink-400">Ask about your sales, expenses, or targets…</span>
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-900">
                      <ArrowRight className="h-[15px] w-[15px] stroke-[2.6] text-white" />
                    </span>
                  </div>
                </PanelShell>
              )}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
