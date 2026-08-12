import { useState } from "react";
import { ButtonLink } from "../Button";
import { RecoveryMeter } from "../RecoveryMeter";
import { Sparkles, ArrowRight, ShieldCheck, Store, Utensils, Croissant } from "lucide-react";
import type { RecoveryTargets } from "../../lib/types";

interface DemoPreset {
  id: string;
  name: string;
  type: string;
  icon: React.ElementType;
  expenses: number;
  sales: number;
  daysLeft: number;
}

const PRESETS: DemoPreset[] = [
  {
    id: "sari-sari",
    name: "Aling Nena's Store",
    type: "Sari-Sari Store",
    icon: Store,
    expenses: 125000,
    sales: 71000,
    daysLeft: 9,
  },
  {
    id: "bakery",
    name: "Santos Craft Bakery",
    type: "Local Bakery",
    icon: Croissant,
    expenses: 180000,
    sales: 115000,
    daysLeft: 12,
  },
  {
    id: "eatery",
    name: "Tita's Carinderia",
    type: "Food Stall & Catering",
    icon: Utensils,
    expenses: 95000,
    sales: 68000,
    daysLeft: 8,
  },
];

function buildDemoTargets(preset: DemoPreset): RecoveryTargets {
  const operatingDays = 25;
  const remainingOperatingDays = Math.max(1, preset.daysLeft - 2);
  const dailyNeededTarget = preset.expenses / operatingDays;
  const remainingTarget = Math.max(0, preset.expenses - preset.sales);
  const adjustedDailyTarget = remainingTarget / remainingOperatingDays;

  return {
    expectedMonthlyExpenses: preset.expenses,
    operatingDays,
    dailyNeededTarget,
    daysInMonth: 31,
    calendarDaysLeftInMonth: preset.daysLeft,
    remainingOperatingDays,
    remainingOperatingDaysIsApproximated: true,
    todaysTarget: Math.round(adjustedDailyTarget),
    todaysSales: Math.round(adjustedDailyTarget * 0.9),
    todaysGap: Math.round(adjustedDailyTarget * -0.1),
    todaysStatus: "below",
    salesThisMonth: preset.sales,
    remainingTarget,
    adjustedDailyTarget,
    monthCoveragePercent: (preset.sales / preset.expenses) * 100,
    onTrack: adjustedDailyTarget <= dailyNeededTarget + 0.005,
  };
}

export function HeroSection() {
  const [selectedPresetId, setSelectedPresetId] = useState<string>("sari-sari");
  const currentPreset = PRESETS.find((p) => p.id === selectedPresetId) || PRESETS[0];
  const demoStatus = buildDemoTargets(currentPreset);

  return (
    <section className="relative overflow-hidden mx-auto max-w-6xl px-4 pb-14 pt-8 lg:px-6 lg:pb-24 lg:pt-14">
      <div className="grid items-center gap-12 lg:grid-cols-12 lg:gap-10">
        
        {/* Left Copy & Actions Column */}
        <div className="lg:col-span-6">
          {/* Eyebrow Pill */}
          <div className="inline-flex items-center gap-2 rounded-full border border-brand-200 bg-brand-50/90 px-3.5 py-1.5 text-xs font-semibold text-brand-800 shadow-2xs">
            <Sparkles className="h-3.5 w-3.5 text-accent-500 fill-accent-400" />
            <span>AI-Powered Financial Tracking for Local Shops</span>
          </div>

          <h1 className="mt-5 font-display text-4xl font-extrabold leading-tight tracking-tight text-ink-900 sm:text-5xl lg:text-[3.25rem]">
            Know where your money actually goes —{" "}
            {/*
              Solid brand teal, not a gradient.

              The gradient ran brand-700 through to accent-600, and because the
              emphasised phrase wraps across two lines the ramp restarted per
              line — so "ends." landed in the olive-brown middle of the blend
              and read like a rendering fault rather than a colour. A gradient
              across wrapping text cannot be controlled, since the box it fills
              changes shape with the viewport.

              A single token also keeps the contrast knowable: brand-700 on
              paper is a measured value, where a point midway through a blend
              into amber is not.
            */}
            <span className="text-brand-700">before the month ends.</span>
          </h1>

          <p className="mt-5 text-base leading-relaxed text-ink-600 sm:text-lg">
            Stop relying on end-of-month notebook guesses. FinSight turns your daily sales and supplier receipts into real-time profit clarity — with an AI assistant that answers your financial questions in plain language.
          </p>

          {/* Primary Action Buttons */}
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <ButtonLink
              to="/register"
              variant="primary"
              size="lg"
              className="bg-accent-400 text-ink-950 hover:bg-accent-300 font-bold shadow-lg shadow-accent-400/20 px-6 py-3.5 rounded-xl transition"
            >
              <span>Start Tracking Free</span>
              <ArrowRight className="ml-2 h-4 w-4 stroke-[2.5]" />
            </ButtonLink>

            <ButtonLink
              to="/login"
              variant="secondary"
              size="lg"
              className="border border-paper-200 bg-paper hover:bg-paper-100 text-ink-900 font-semibold px-6 py-3.5 rounded-xl shadow-2xs"
            >
              <span>Log in to Account</span>
            </ButtonLink>
          </div>

          {/*
            A "500+ Philippines store owners rely on FinSight daily" badge sat
            here, with three stacked avatars reading N, R and G — the initials
            of the three invented testimonial authors deleted earlier. It was
            the last piece of that fabrication still on the page.

            Nothing replaces it. An empty space is the honest state until there
            is a real number to put in it, and the strongest evidence on this
            page is the panel to the right: the actual RecoveryMeter component
            running on figures that say they are an example.
          */}
        </div>

        {/* Right Live Interactive Demo Meter Column */}
        <div className="lg:col-span-6 relative">
          {/* Subtle Ambient Backlight Glow */}
          <div
            aria-hidden
            className="absolute -inset-4 -z-10 rounded-[2.5rem] bg-gradient-to-br from-brand-100/60 via-amber-100/40 to-paper-100 blur-2xl"
          />

          <div className="relative rounded-3xl bg-paper p-5 shadow-2xl border border-paper-200 sm:p-6">
            
            {/* Header & Store Preset Toggles */}
            <div className="mb-4 flex flex-wrap items-center justify-between gap-2 border-b border-paper-200 pb-3">
              <div>
                <p className="text-[11px] font-bold uppercase tracking-wider text-ink-400">
                  Interactive Live Meter Demo
                </p>
                <h2 className="font-display text-base font-bold text-ink-900 flex items-center gap-1.5">
                  <span>{currentPreset.name}</span>
                  <span className="text-xs font-normal text-ink-500">({currentPreset.type})</span>
                </h2>
              </div>
              <span className="rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-700 border border-emerald-200/60 flex items-center gap-1">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
                Live Calculator
              </span>
            </div>

            {/* Store Type Preset Switcher Tabs */}
            <div className="mb-4 flex gap-1.5 overflow-x-auto pb-1">
              {PRESETS.map((preset) => {
                const Icon = preset.icon;
                const isSelected = preset.id === selectedPresetId;
                return (
                  <button
                    key={preset.id}
                    type="button"
                    onClick={() => setSelectedPresetId(preset.id)}
                    className={`flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-semibold transition ${
                      isSelected
                        ? "bg-brand-700 text-white shadow-xs"
                        : "bg-paper-100 text-ink-600 hover:bg-paper-200"
                    }`}
                  >
                    <Icon className="h-3.5 w-3.5" />
                    <span>{preset.type.split(" ")[0]}</span>
                  </button>
                );
              })}
            </div>

            {/* Render actual Recovery Meter Component */}
            <div className="rounded-2xl bg-paper-50/80 p-2 border border-paper-200">
              <RecoveryMeter recoveryStatus={demoStatus} />
            </div>

            <div className="mt-4 flex items-center justify-between text-xs text-ink-500 pt-2 border-t border-paper-200">
              <span className="flex items-center gap-1">
                <ShieldCheck className="h-3.5 w-3.5 text-brand-600" /> Real component fed with demo store targets
              </span>
              <span className="font-medium text-brand-700">Select store above ☝️</span>
            </div>
          </div>
        </div>

      </div>
    </section>
  );
}
